# 🏠 SimpleNAS v3.2

SimpleNAS is a "Granny-friendly" storage appliance built on top of Debian. It provides a modern, responsive web interface to manage **MergerFS** (pooling) and **SnapRAID** (parity protection) with zero command-line interaction required after setup.

## 🚀 Quick Install

To install SimpleNAS on a fresh **Debian 13** or **Ubuntu 24.04** system, run:

```bash
curl -sSL https://raw.githubusercontent.com/YOUR_USER/SimpleNAS/main/install.sh | sudo bash
```

*(Note: Replace `YOUR_USER` with your GitHub username after pushing.)*

---

## ✨ Features

- **Ghost Drive Protection**: Uses persistent hardware Serial IDs for all mounts.
- **Dual-Parity Support**: Survive up to 2 simultaneous drive failures.
- **Safety Valve**: Automated syncs abort if drives are missing or massive data loss is detected.
- **Magic Undelete**: Recover accidentally deleted files directly from parity via the UI.
- **S.M.A.R.T. Monitoring**: Real-time temperature and health tracking.
- **Zero-Config Pooling**: MergerFS pool is automatically managed and shared via Samba.

---

## 🛠️ Requirements

- **OS**: Debian 13 (Recommended) or Ubuntu 24.04+.
- **Hardware**: Any x86_64 system with at least 2GB RAM.
- **Disks**: At least one data disk and one parity disk (parity must be >= largest data disk).

---

## 🏗️ Manual Setup (Developers)

If you prefer to install manually:

1. **Clone the repo**: `git clone https://github.com/YOUR_USER/SimpleNAS.git`
2. **Install Backend**:
   ```bash
   cd backend
   npm install
   node server.js
   ```
3. **Install Frontend**:
   ```bash
   cd frontend
   npm install
   npm run build
   ```

---

## 📄 License

MIT
