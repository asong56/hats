use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BEGIN_TAG: &str = "# --- HATS-MANAGED-BEGIN ---";
const END_TAG: &str = "# --- HATS-MANAGED-END ---";
const DEFAULT_YAML: &str = include_str!("default.yml");
const BACKUP_SUFFIX: &str = ".hats-backup";

// ---------------------------------------------------------------------
// Config model
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
struct Config {
    #[serde(default = "default_true")]
    auto_flush_dns: bool,
    #[serde(default)]
    profiles: Vec<Profile>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Profile {
    id: String,
    name: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    entries: Vec<HostEntry>,
    #[serde(default)]
    include: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct HostEntry {
    ip: String,
    domains: Vec<String>,
    comment: Option<String>,
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

#[derive(Parser, Debug)]
#[command(
    name = "hats",
    author,
    version,
    about = "Ultra-fast CLI hosts manager powered by YAML — a keyboard-driven alternative to SwitchHosts"
)]
struct Cli {
    /// Path to the YAML configuration file
    #[arg(short, long, global = true, default_value = "default.yml")]
    config: PathBuf,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Apply enabled profiles to the system hosts file (default action)
    Apply {
        /// Skip DNS cache flushing even if enabled in config
        #[arg(long)]
        no_flush: bool,
        /// Print generated hosts content without writing to the system file
        #[arg(long)]
        dry_run: bool,
    },
    /// List all profiles and whether they're enabled
    List,
    /// Enable one or more profiles by id
    Enable {
        /// Profile id(s) to enable
        ids: Vec<String>,
    },
    /// Disable one or more profiles by id
    Disable {
        /// Profile id(s) to disable
        ids: Vec<String>,
    },
    /// Show the currently active managed block in the system hosts file
    Status,
    /// Validate the configuration file without touching the system hosts file
    Check,
    /// Restore the system hosts file from the most recent hats backup
    Restore,
}

// ---------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------

fn get_hosts_path() -> Result<PathBuf> {
    if cfg!(target_os = "windows") {
        let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        Ok(PathBuf::from(sys_root).join("System32\\drivers\\etc\\hosts"))
    } else {
        Ok(PathBuf::from("/etc/hosts"))
    }
}

fn is_admin() -> bool {
    #[cfg(target_os = "windows")]
    {
        extern "system" {
            fn IsUserAnAdmin() -> i32;
        }
        unsafe { IsUserAnAdmin() != 0 }
    }
    #[cfg(unix)]
    {
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(any(target_os = "windows", unix)))]
    {
        false
    }
}

fn flush_dns() {
    println!("⚡ Flushing system DNS cache...");
    let status = if cfg!(target_os = "windows") {
        Command::new("ipconfig").arg("/flushdns").status()
    } else if cfg!(target_os = "macos") {
        // We already run as root by this point (is_admin() gated the caller),
        // so invoking `sudo` again here is redundant and can trigger an
        // unwanted extra password prompt in some shells/configs.
        Command::new("killall")
            .args(["-HUP", "mDNSResponder"])
            .status()
    } else if cfg!(target_os = "linux") {
        if Command::new("which")
            .arg("resolvectl")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            Command::new("resolvectl").arg("flush-caches").status()
        } else {
            Command::new("systemd-resolve")
                .arg("--flush-caches")
                .status()
        }
    } else {
        println!("⚠️ DNS flushing is not supported on this platform.");
        return;
    };

    match status {
        Ok(s) if s.success() => println!("✓ DNS cache flushed successfully."),
        _ => println!("⚠️ Could not automatically flush DNS cache (this is non-fatal)."),
    }
}

// ---------------------------------------------------------------------
// Config loading / validation
// ---------------------------------------------------------------------

fn ensure_config_exists(config_path: &Path) -> Result<()> {
    if !config_path.exists() {
        println!(
            "💡 Config file not found. Creating default config at: {:?}",
            config_path
        );
        fs::write(config_path, DEFAULT_YAML)
            .with_context(|| format!("Failed to create default config at {:?}", config_path))?;
    }
    Ok(())
}

fn load_config(config_path: &Path) -> Result<Config> {
    ensure_config_exists(config_path)?;
    let yaml_str = fs::read_to_string(config_path)
        .with_context(|| format!("Failed to read config file: {:?}", config_path))?;
    let config: Config =
        serde_yaml::from_str(&yaml_str).context("Failed to parse YAML configuration")?;
    validate_config(&config)?;
    Ok(config)
}

fn save_config(config_path: &Path, config: &Config) -> Result<()> {
    let yaml = serde_yaml::to_string(config).context("Failed to serialize configuration")?;
    fs::write(config_path, yaml)
        .with_context(|| format!("Failed to write config file: {:?}", config_path))
}

/// Catch mistakes early: duplicate ids, dangling includes, obviously malformed
/// IPs, and include cycles (reported clearly instead of silently truncated).
fn validate_config(config: &Config) -> Result<()> {
    let mut seen_ids = HashSet::new();
    for profile in &config.profiles {
        if !seen_ids.insert(profile.id.as_str()) {
            bail!("Duplicate profile id found in config: '{}'", profile.id);
        }
        for entry in &profile.entries {
            if entry.ip.trim().is_empty() {
                bail!("Profile '{}' has an entry with an empty ip", profile.id);
            }
            if entry.domains.is_empty() {
                bail!(
                    "Profile '{}' has an entry for ip '{}' with no domains",
                    profile.id,
                    entry.ip
                );
            }
            if entry.ip.parse::<std::net::IpAddr>().is_err() {
                println!(
                    "⚠️ Warning: '{}' in profile '{}' doesn't look like a valid IP address.",
                    entry.ip, profile.id
                );
            }
        }
    }

    let profile_map: HashMap<&str, &Profile> = config
        .profiles
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();

    for profile in &config.profiles {
        for inc_id in &profile.include {
            if !profile_map.contains_key(inc_id.as_str()) {
                bail!(
                    "Profile '{}' includes unknown profile id '{}'",
                    profile.id,
                    inc_id
                );
            }
        }
        detect_cycle(profile.id.as_str(), &profile_map, &mut Vec::new())?;
    }

    Ok(())
}

fn detect_cycle<'a>(
    id: &'a str,
    profile_map: &HashMap<&'a str, &'a Profile>,
    path: &mut Vec<&'a str>,
) -> Result<()> {
    if path.contains(&id) {
        path.push(id);
        bail!("Circular 'include' detected: {}", path.join(" -> "));
    }
    path.push(id);
    if let Some(profile) = profile_map.get(id) {
        for inc_id in &profile.include {
            detect_cycle(inc_id.as_str(), profile_map, path)?;
        }
    }
    path.pop();
    Ok(())
}

// ---------------------------------------------------------------------
// Entry collection
// ---------------------------------------------------------------------

/// Collects entries for a single top-level profile. `visited` is intentionally
/// local to each top-level call (see `main`) so that processing one enabled
/// profile can never cause another, unrelated enabled profile to be skipped;
/// it only guards against `include` cycles/duplication within one profile's
/// own dependency tree.
fn collect_profile_entries<'a>(
    profile: &'a Profile,
    profile_map: &HashMap<&str, &'a Profile>,
    output_entries: &mut Vec<String>,
    visited: &mut HashSet<&'a str>,
) {
    if visited.contains(profile.id.as_str()) {
        return;
    }
    visited.insert(&profile.id);

    for entry in &profile.entries {
        for domain in &entry.domains {
            let comment_part = entry
                .comment
                .as_ref()
                .map_or(String::new(), |c| format!(" # {}", c));
            output_entries.push(format!("{}\t{}{}", entry.ip, domain, comment_part));
        }
    }

    for inc_id in &profile.include {
        if let Some(target_profile) = profile_map.get(inc_id.as_str()) {
            collect_profile_entries(target_profile, profile_map, output_entries, visited);
        }
        // Unknown includes are caught by validate_config() before we get here.
    }
}

fn generate_managed_block(config: &Config) -> String {
    let profile_map: HashMap<&str, &Profile> = config
        .profiles
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();

    let mut raw_entries = Vec::new();

    for profile in &config.profiles {
        if profile.enabled {
            // Fresh `visited` set per top-level profile: enabling profile A
            // must never suppress profile B's direct entries just because B
            // happened to already appear via A's include chain — B's own
            // entries are still authoritative when B itself is enabled.
            let mut visited = HashSet::new();
            collect_profile_entries(profile, &profile_map, &mut raw_entries, &mut visited);
        }
    }

    // Deduplicate identical lines while preserving order.
    let mut seen = HashSet::new();
    let mut unique_entries = Vec::new();
    for entry in raw_entries {
        if seen.insert(entry.clone()) {
            unique_entries.push(entry);
        }
    }

    unique_entries.join("\n")
}

// ---------------------------------------------------------------------
// Hosts file read/write with backup
// ---------------------------------------------------------------------

fn backup_path(hosts_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}{}", hosts_path.display(), BACKUP_SUFFIX))
}

fn strip_managed_block(existing_hosts: &str) -> String {
    let mut clean_lines = Vec::new();
    let mut inside_block = false;
    for line in existing_hosts.lines() {
        let trimmed = line.trim();
        if trimmed == BEGIN_TAG {
            inside_block = true;
            continue;
        }
        if trimmed == END_TAG {
            inside_block = false;
            continue;
        }
        if !inside_block {
            clean_lines.push(line);
        }
    }
    clean_lines.join("\n")
}

fn build_final_content(clean_content: &str, generated_block_content: &str) -> String {
    let mut final_content = clean_content.to_string();
    if !final_content.is_empty() && !final_content.ends_with('\n') {
        final_content.push('\n');
    }
    final_content.push('\n');
    final_content.push_str(BEGIN_TAG);
    final_content.push_str("\n# Managed by hats CLI - DO NOT EDIT MANUALLY WITHIN THIS BLOCK\n");
    final_content.push_str(generated_block_content);
    if !generated_block_content.is_empty() && !generated_block_content.ends_with('\n') {
        final_content.push('\n');
    }
    final_content.push_str(END_TAG);
    final_content.push('\n');
    final_content
}

fn require_admin() -> Result<()> {
    if !is_admin() {
        eprintln!("❌ Error: Modifying the system hosts file requires Administrator / Root privileges.");
        if cfg!(target_os = "windows") {
            eprintln!("👉 Please run PowerShell or Command Prompt as Administrator, then re-run `hats`.");
        } else {
            eprintln!("👉 Please run with `sudo hats`.");
        }
        std::process::exit(1);
    }
    Ok(())
}

fn cmd_apply(config_path: &Path, no_flush: bool, dry_run: bool) -> Result<()> {
    let config = load_config(config_path)?;
    let generated_block_content = generate_managed_block(&config);

    if dry_run {
        println!("--- [DRY RUN] Generated Managed Block ---");
        println!(
            "{}\n# Managed by hats CLI\n{}",
            BEGIN_TAG, generated_block_content
        );
        println!("{}", END_TAG);
        println!("--- End of DRY RUN ---");
        return Ok(());
    }

    require_admin()?;

    let hosts_path = get_hosts_path()?;
    println!("Target system hosts path: {:?}", hosts_path);

    let existing_hosts = fs::read_to_string(&hosts_path).unwrap_or_default();

    // Take a one-time backup of the *original, untouched* hosts file before
    // the first write, so `hats restore` always has something meaningful
    // even after repeated `apply` runs.
    let backup = backup_path(&hosts_path);
    if !backup.exists() {
        fs::write(&backup, &existing_hosts)
            .with_context(|| format!("Failed to create backup at {:?}", backup))?;
        println!("🗄  Backed up original hosts file to: {:?}", backup);
    }

    let clean_content = strip_managed_block(&existing_hosts);
    let final_content = build_final_content(&clean_content, &generated_block_content);

    fs::write(&hosts_path, final_content)
        .with_context(|| format!("Failed to write to system hosts file at {:?}", hosts_path))?;

    println!("✓ Successfully applied hosts rules!");

    if config.auto_flush_dns && !no_flush {
        flush_dns();
    }

    Ok(())
}

fn cmd_list(config_path: &Path) -> Result<()> {
    let config = load_config(config_path)?;
    if config.profiles.is_empty() {
        println!("No profiles defined in {:?}", config_path);
        return Ok(());
    }
    println!("{:<18} {:<8} {:<28} entries", "ID", "ENABLED", "NAME");
    println!("{}", "-".repeat(70));
    for p in &config.profiles {
        let mark = if p.enabled { "✓ on" } else { "  off" };
        let entry_count: usize = p.entries.iter().map(|e| e.domains.len()).sum();
        let include_note = if p.include.is_empty() {
            String::new()
        } else {
            format!(" (includes: {})", p.include.join(", "))
        };
        println!(
            "{:<18} {:<8} {:<28} {} domain(s){}",
            p.id, mark, p.name, entry_count, include_note
        );
    }
    Ok(())
}

fn cmd_set_enabled(config_path: &Path, ids: &[String], enabled: bool) -> Result<()> {
    if ids.is_empty() {
        bail!("Please provide at least one profile id.");
    }
    let mut config = load_config(config_path)?;

    let known_ids: HashSet<&str> = config.profiles.iter().map(|p| p.id.as_str()).collect();
    for id in ids {
        if !known_ids.contains(id.as_str()) {
            bail!(
                "Unknown profile id '{}'. Run `hats list` to see available profiles.",
                id
            );
        }
    }

    for profile in config.profiles.iter_mut() {
        if ids.iter().any(|id| id == &profile.id) {
            profile.enabled = enabled;
        }
    }

    save_config(config_path, &config)?;
    let verb = if enabled { "Enabled" } else { "Disabled" };
    println!("{} profile(s): {}", verb, ids.join(", "));
    println!("Run `hats apply` (with sudo/admin) to apply these changes to the system hosts file.");
    Ok(())
}

fn cmd_status() -> Result<()> {
    let hosts_path = get_hosts_path()?;
    let existing_hosts = fs::read_to_string(&hosts_path).unwrap_or_default();

    let mut inside_block = false;
    let mut block_lines = Vec::new();
    for line in existing_hosts.lines() {
        let trimmed = line.trim();
        if trimmed == BEGIN_TAG {
            inside_block = true;
            continue;
        }
        if trimmed == END_TAG {
            break;
        }
        if inside_block {
            block_lines.push(line);
        }
    }

    if block_lines.is_empty() {
        println!("No hats-managed block currently present in {:?}.", hosts_path);
    } else {
        println!("Active hats-managed block in {:?}:\n", hosts_path);
        for line in block_lines {
            println!("{}", line);
        }
    }
    Ok(())
}

fn cmd_check(config_path: &Path) -> Result<()> {
    let config = load_config(config_path)?;
    let enabled_count = config.profiles.iter().filter(|p| p.enabled).count();
    println!(
        "✓ Configuration is valid: {} profile(s) total, {} enabled.",
        config.profiles.len(),
        enabled_count
    );
    Ok(())
}

fn cmd_restore() -> Result<()> {
    require_admin()?;
    let hosts_path = get_hosts_path()?;
    let backup = backup_path(&hosts_path);
    if !backup.exists() {
        bail!(
            "No backup found at {:?}. Nothing to restore (hats only creates a backup the first time it applies changes).",
            backup
        );
    }
    let backup_content = fs::read_to_string(&backup)
        .with_context(|| format!("Failed to read backup at {:?}", backup))?;
    fs::write(&hosts_path, backup_content)
        .with_context(|| format!("Failed to restore hosts file at {:?}", hosts_path))?;
    println!("✓ Restored {:?} from backup {:?}", hosts_path, backup);
    Ok(())
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Commands::Apply {
        no_flush: false,
        dry_run: false,
    }) {
        Commands::Apply { no_flush, dry_run } => cmd_apply(&cli.config, no_flush, dry_run),
        Commands::List => cmd_list(&cli.config),
        Commands::Enable { ids } => cmd_set_enabled(&cli.config, &ids, true),
        Commands::Disable { ids } => cmd_set_enabled(&cli.config, &ids, false),
        Commands::Status => cmd_status(),
        Commands::Check => cmd_check(&cli.config),
        Commands::Restore => cmd_restore(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_and_rebuild_roundtrip() {
        let original = "127.0.0.1 localhost\n# --- HATS-MANAGED-BEGIN ---\nold junk\n# --- HATS-MANAGED-END ---\n::1 localhost\n";
        let clean = strip_managed_block(original);
        assert!(!clean.contains("old junk"));
        assert!(clean.contains("127.0.0.1 localhost"));
        assert!(clean.contains("::1 localhost"));

        let rebuilt = build_final_content(&clean, "0.0.0.0\tad.example.com");
        assert!(rebuilt.contains(BEGIN_TAG));
        assert!(rebuilt.contains(END_TAG));
        assert!(rebuilt.contains("0.0.0.0\tad.example.com"));
        assert!(!rebuilt.contains("old junk"));
    }

    #[test]
    fn shared_entries_not_lost_across_top_level_profiles() {
        let config = Config {
            auto_flush_dns: true,
            profiles: vec![
                Profile {
                    id: "base".into(),
                    name: "Base".into(),
                    enabled: true,
                    entries: vec![HostEntry {
                        ip: "0.0.0.0".into(),
                        domains: vec!["ads.example.com".into()],
                        comment: None,
                    }],
                    include: vec![],
                },
                Profile {
                    id: "suite".into(),
                    name: "Suite".into(),
                    enabled: true,
                    entries: vec![],
                    include: vec!["base".into()],
                },
            ],
        };
        let block = generate_managed_block(&config);
        assert_eq!(block, "0.0.0.0\tads.example.com");
    }

    #[test]
    fn detects_duplicate_ids() {
        let config = Config {
            auto_flush_dns: true,
            profiles: vec![
                Profile { id: "a".into(), name: "A".into(), enabled: true, entries: vec![], include: vec![] },
                Profile { id: "a".into(), name: "A2".into(), enabled: true, entries: vec![], include: vec![] },
            ],
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn detects_include_cycles() {
        let config = Config {
            auto_flush_dns: true,
            profiles: vec![
                Profile { id: "a".into(), name: "A".into(), enabled: true, entries: vec![], include: vec!["b".into()] },
                Profile { id: "b".into(), name: "B".into(), enabled: true, entries: vec![], include: vec!["a".into()] },
            ],
        };
        assert!(validate_config(&config).is_err());
    }
}
