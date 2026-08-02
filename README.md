# 🎩 hats

**hats** is a blazing-fast CLI hosts manager powered by YAML — a keyboard‑driven alternative to [SwitchHosts](https://github.com/oldj/SwitchHosts) for those who prefer toggling profiles from a terminal, script, or CI job rather than clicking through a GUI.

---

## ✨ Features

- **YAML configuration** – clean, readable, and supports profile inheritance via `include`.
- **Full CLI control** – `enable`/`disable`/`list`/`status` for quick profile switching.
- **Safe & reliable**:
  - Automatically backs up your original hosts file before the first write.
  - Only touches a clearly delimited managed block, leaving your manual entries untouched.
  - Validates configs for duplicate IDs, dangling includes, and circular dependencies.
- **Cross‑platform** – works on Windows, macOS, and Linux.
- **DNS cache flushing** – optional automatic flush after each apply (configurable).
- **Script‑friendly** – all commands return proper exit codes, ideal for automation.

---

## 🚀 Installation

### Build from source (requires Rust 1.75+)

```bash
git clone https://github.com/yourusername/hats.git
cd hats
cargo build --release
sudo cp target/release/hats /usr/local/bin/   # Linux/macOS
```

> Pre‑built binaries will be available in future releases.

---

## ⚡ Quick Start

### 1. Generate a default config

```bash
hats list
```
This creates `default.yml` in the current directory with example profiles.

### 2. List available profiles

```bash
hats list
```
Example output:
```
ID                 ENABLED  NAME                       entries
----------------------------------------------------------------------
base-adblock       ✓ on     Base Ad-Blocker           2 domain(s)
dev-local          ✓ on     Local Development         3 domain(s)
staging-env          off     Staging Environment       1 domain(s)
dev-suite            off     Full Development Suite    0 domain(s) (includes: base-adblock, dev-local)
```

### 3. Enable / disable profiles

```bash
hats enable dev-suite staging-env
hats disable dev-local
```

### 4. Preview changes without touching the system

```bash
hats apply --dry-run
```

### 5. Apply changes (requires admin privileges)

```bash
sudo hats apply
```

### 6. Show the currently active managed block

```bash
hats status
```

### 7. Restore from backup

```bash
sudo hats restore
```

---

## 📁 Configuration

The default config file is `default.yml` (can be overridden with `-c`). Structure:

```yaml
auto_flush_dns: true   # flush DNS cache after each successful apply

profiles:
  - id: base-adblock
    name: "Base Ad-Blocker"
    enabled: true
    entries:
      - ip: "0.0.0.0"
        domains: ["ad.example.com", "tracker.analytics.com"]
        comment: "Block tracking domains"

  - id: dev-local
    name: "Local Development"
    enabled: true
    entries:
      - ip: "127.0.0.1"
        domains: ["app.local", "api.local", "db.local"]
        comment: "Local microservices"

  - id: dev-suite
    name: "Full Development Suite"
    enabled: false
    include:
      - base-adblock
      - dev-local
```

- `id` – unique identifier used by CLI commands and `include` references.
- `enabled` – whether this profile contributes entries on `hats apply`.
- `entries` – list of `{ ip, domains, comment? }` mappings.
- `include` – list of other profile IDs to pull in (their entries are included regardless of their own `enabled` flag). Circular and dangling includes are rejected by `hats check`.

---

## 🛠️ Command Reference

| Command | Description |
|---------|-------------|
| `hats apply` | Write enabled profiles to the system hosts file (needs `sudo`). |
| `hats apply --dry-run` | Print generated content without writing. |
| `hats apply --no-flush` | Skip DNS cache flush even if enabled in config. |
| `hats list` | List all profiles with their status and includes. |
| `hats enable <id>...` | Enable one or more profiles (updates the YAML). |
| `hats disable <id>...` | Disable one or more profiles. |
| `hats status` | Display the managed block currently in the system hosts file. |
| `hats check` | Validate the configuration file (no duplicate IDs, no broken includes, no cycles). |
| `hats restore` | Restore the hosts file from the backup (needs `sudo`). |

> **Note:** `enable`/`disable` only modify the YAML config – you must run `sudo hats apply` for changes to take effect in the system hosts file.

---

## 🔒 Safety & Backup

- **Automatic backup**: The first `sudo hats apply` saves a copy of the current hosts file as `<hosts_path>.hats-backup`.
- **Restore**: Use `sudo hats restore` to revert to that backup.
- **Managed block only**: hats writes between `# --- HATS-MANAGED-BEGIN ---` and `# --- HATS-MANAGED-END ---`; everything else remains as‑is.