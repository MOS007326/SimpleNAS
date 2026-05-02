#!/bin/bash

# SimpleNAS v3.4.2 Automated Installer
# Supported OS: Debian 13 (Trixie), Ubuntu 24.04+

set -e

# --- Configuration ---
INSTALL_DIR="/opt/simplenas"
REPO_URL="https://github.com/MOS007326/SimpleNAS.git" # User should update this after pushing

echo "🚀 Starting SimpleNAS v3.1 Installation..."

# 1. Check for root
if [ "$EUID" -ne 0 ]; then 
  echo "❌ Please run as root (use sudo)."
  exit 1
fi

# 2. Install System Dependencies
echo "📦 Installing system packages (mergerfs, snapraid, samba, smartmontools)..."
apt-get update
apt-get install -y mergerfs snapraid samba samba-common-bin smartmontools parted nodejs npm git curl

# 3. Create Installation Directory
echo "📁 Setting up installation directory at $INSTALL_DIR..."
mkdir -p $INSTALL_DIR

# 4. Clone or Update Repo
if [ -d "$INSTALL_DIR/.git" ]; then
    echo "🔄 Updating existing installation..."
    cd $INSTALL_DIR
    git pull
else
    echo "📥 Cloning SimpleNAS repository..."
    git clone $REPO_URL $INSTALL_DIR
    cd $INSTALL_DIR
fi

# 5. Install Backend Dependencies
echo "⚙️ Setting up backend..."
cd $INSTALL_DIR/backend
npm install --production

# 6. Install Frontend Dependencies & Build
echo "🏗️ Building frontend (this may take a minute)..."
cd $INSTALL_DIR/frontend
npm install
npm run build

# 7. Setup Systemd Service
echo "🛠️ Configuring systemd service..."
cp $INSTALL_DIR/simplenas.service /etc/systemd/system/simplenas.service
systemctl daemon-reload
systemctl enable simplenas

# 8. Create Mount Points
echo "📂 Creating default mount points..."
mkdir -p /mnt/pool

# 9. Start Service
echo "🏁 Starting SimpleNAS service..."
systemctl restart simplenas

# 10. Success Message
IP_ADDR=$(hostname -I | awk '{print $1}')
echo ""
echo "#########################################################"
echo "🎉 SimpleNAS v3.4.2 Installation Complete!"
echo "#########################################################"
echo ""
echo "You can access your NAS dashboard at:"
echo "👉 http://$IP_ADDR"
echo ""
echo "Next Steps:"
echo "1. Open the dashboard in your browser."
echo "2. Go to 'Storage' to add your first drives."
echo "3. Enable a 'Share' to start copying files."
echo ""
echo "#########################################################"
