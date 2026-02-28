#!/bin/bash

# 屏幕共享应用一键部署脚本 (完整版)
# 运行方式: sudo bash deploy.sh

set -e

echo "===== 开始部署屏幕共享应用 ====="

# 1. 安装Node.js
echo "[1/8] 安装Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash - || true
apt-get install -y nodejs || true
node -v || echo "Node.js安装可能需要手动确认"

# 2. 安装Nginx和Certbot
echo "[2/8] 安装Nginx和SSL证书工具..."
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx

# 3. 创建应用目录
echo "[3/8] 创建应用目录..."
mkdir -p /var/www/screenshare
cd /var/www/screenshare

# 4. 创建package.json
echo "[4/8] 创建应用配置..."
cat > package.json << 'PKGEOF'
{
  "name": "screenshare-relay",
  "version": "1.0.0",
  "description": "Multi-viewer screen sharing with cascade relay",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "uuid": "^9.0.1"
  }
}
PKGEOF

mkdir -p server public

# 5. 配置防火墙
echo "[5/8] 配置防火墙..."
ufw allow 22/tcp 2>/dev/null || true
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true
ufw allow 3000/tcp 2>/dev/null || true

# 6. 配置Nginx
echo "[6/8] 配置Nginx..."
cat > /etc/nginx/sites-available/screenshare << 'NGINXEOF'
server {
    listen 80;
    listen [::]:80;
    server_name _;

    root /var/www/screenshare/public;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/screenshare /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t

# 7. 启动Node.js
echo "[7/8] 安装Node.js依赖..."
cd /var/www/screenshare
npm install

# 8. 创建启动脚本
echo "[8/8] 创建启动脚本..."
cat > start.sh << 'STARTEOF'
#!/bin/bash
cd /var/www/screenshare
npm start
STARTEOF
chmod +x start.sh

# 创建PM2配置（后台运行）
npm install -g pm2
pm2 start start.sh --name screenshare
pm2 save

echo ""
echo "===== 部署完成 ====="
echo ""
echo "请用FileZilla上传以下文件到 /var/www/screenshare/ :"
echo "  - server/index.js"
echo "  - public/index.html"
echo "  - public/style.css"
echo "  - public/app.js"
echo "  - public/favicon.ico"
echo ""
echo "上传完成后运行: pm2 restart screenshare"
echo ""
echo "访问 http://39.97.252.31 测试"
