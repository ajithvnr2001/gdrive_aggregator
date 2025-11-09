# Enhanced Google Drive Browser - Deployment Commands

## 📋 Complete Command Reference

This document contains all commands required to set up, develop, deploy, and manage the Enhanced Google Drive Browser application with:

- ✅ Cloudflare direct download proxy (24-hour links, zero token exposure)
- ✅ File rename and move operations
- ✅ Professional modal UI with clipboard integration
- ✅ Native INI parser (no external dependencies)
- ✅ Full rclone config compatibility

## 🚀 Initial Setup

### Prerequisites Installation

#### Install Node.js (Required)
```bash
# Check current Node.js version
node --version
npm --version

# If not installed, download from https://nodejs.org/
# Recommended: Node.js 18+ and npm 8+
```

#### Install Wrangler CLI
```bash
# Install Wrangler globally via npm
npm install -g wrangler

# Verify installation
wrangler --version

# Update Wrangler (if needed)
npm update -g wrangler
```

#### Install Project Dependencies
```bash
# Navigate to project directory
cd "D:\multicloud aggregator"

# Install dependencies
npm install

# Verify installation
npm list
```

## 🔐 Cloudflare Authentication

### Login to Cloudflare
```bash
# Login to Cloudflare (opens browser for OAuth)
wrangler login

# Verify authentication
wrangler whoami
```

### Check Cloudflare Account
```bash
# View account information
wrangler whoami

# List available zones (domains)
wrangler zone list
```

## 🗂️ Cloudflare KV Setup

### Create KV Namespace
```bash
# Create the CONFIGS namespace for storing encrypted configs
wrangler kv:namespace create CONFIGS

# Expected output:
# 🌀 Creating namespace with title "CONFIGS"
# ✨ Success!
# To access your new KV Namespace in your Worker, add the following snippet to your configuration file:
# {
#   "kv_namespaces": [
#     {
#       "binding": "CONFIGS",
#       "id": "51b1428262d34206950d75a93426af02"
#     }
#   ]
# }
```

### List KV Namespaces
```bash
# List all KV namespaces in your account
wrangler kv:namespace list

# Expected output:
# id                    title    created
# 51b1428262d34206950d75a93426af02  CONFIGS  2025-11-08T05:19:56.000Z
```

### Get KV Namespace ID
```bash
# If you need to find the namespace ID later
wrangler kv:namespace list | grep CONFIGS
```

## 🔑 Security Configuration

### Generate Encryption Key
```bash
# Generate a secure 256-bit encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Example output: 0291cc17339bfc9628a6b5035fb3084d7949abd85a6f580b063dc6285566ecbd
```

### Update Configuration Files
```bash
# After creating KV namespace, update wrangler.jsonc with the actual ID
# Edit wrangler.jsonc and replace YOUR_KV_NAMESPACE_ID with the actual ID

# The file should look like:
# {
#   "name": "gdrive-browser",
#   "main": "worker.js",
#   "compatibility_date": "2024-11-01",
#   "kv_namespaces": [
#     {
#       "binding": "CONFIGS",
#       "id": "51b1428262d34206950d75a93426af02"
#     }
#   ],
#   "vars": {
#     "ENCRYPTION_KEY": "0291cc17339bfc9628a6b5035fb3084d7949abd85a6f580b063dc6285566ecbd"
#   }
# }
```

## 💻 Development Commands

### Start Local Development Server
```bash
# Start development server with hot reload
npm run dev

# Or directly with wrangler
wrangler dev

# Expected output:
# ⛅️ wrangler 4.36.0
# ─────────────────────────────────────────────
# Your Worker is running at:
# - http://localhost:8787
# - http://127.0.0.1:8787
#
# [2025-11-08 05:21:00] GET / 200 OK
```

### Development with Custom Port
```bash
# Start on specific port
wrangler dev --port 3000

# Start with custom host
wrangler dev --host 0.0.0.0
```

### Development with Environment Variables
```bash
# Use custom environment file
wrangler dev --env-file .env.local

# Or set variables inline
wrangler dev --var ENCRYPTION_KEY:your-key-here
```

## 🚀 Deployment Commands

### Deploy to Production
```bash
# Deploy the worker to Cloudflare
npm run deploy

# Or directly with wrangler
wrangler deploy

# Expected output:
# ⛅️ wrangler 4.36.0
# ─────────────────────────────────────────────
# Total Upload: 19.60 KiB / gzip: 5.54 KiB
# Your Worker has access to the following bindings:
# Binding                                                              Resource
# env.CONFIGS (51b1428262d34206950d75a93426af02)                       KV Namespace
# env.ENCRYPTION_KEY ("0291cc17339bfc9628a6b5035fb3084d7949a...")      Environment Variable
#
# Uploaded gdrive-browser (8.58 sec)
# Deployed gdrive-browser triggers (3.41 sec)
# https://gdrive-browser.ltimindtree.workers.dev
# Current Version ID: c3fa16fd-66d5-4f7f-a54b-41c76c429d1e
```

### Check Deployment Status
```bash
# Check if deployment was successful
wrangler deployments list

# View deployment details
wrangler deployments list --name gdrive-browser
```

### Rollback Deployment
```bash
# If deployment fails, rollback to previous version
wrangler rollback <version-id>

# Get version ID from deployments list
wrangler deployments list
wrangler rollback 00f39fa7-346f-485c-8a47-0af678df6f08
```

## 📊 Monitoring & Logging

### View Worker Logs
```bash
# Start real-time log tailing
wrangler tail

# Tail logs for specific worker
wrangler tail gdrive-browser

# Tail with filters
wrangler tail --format=pretty
wrangler tail --level=error
```

### Monitor Worker Performance
```bash
# View worker analytics (requires Cloudflare dashboard access)
# Visit: https://dash.cloudflare.com/ -> Workers -> gdrive-browser

# Check worker usage
wrangler tail --metrics
```

### Check Worker Health
```bash
# Quick health check - make a test request
curl -I https://gdrive-browser.ltimindtree.workers.dev

# Test new API endpoints
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{"test": "data"}' \
     https://gdrive-browser.ltimindtree.workers.dev/api/get-direct-link

# Test Cloudflare proxy download (requires valid session/file)
curl -I https://gdrive-browser.ltimindtree.workers.dev/download/session-id/file-id/filename

# Or download a file
curl -O https://gdrive-browser.ltimindtree.workers.dev/download/session-id/file-id/filename

# Check response headers
curl -v https://gdrive-browser.ltimindtree.workers.dev
```

## 🔧 Management Commands

### Update Worker Configuration
```bash
# Update environment variables
wrangler secret put ENCRYPTION_KEY
# (will prompt for value)

# Update KV namespace binding
wrangler kv:namespace create CONFIGS --preview false
```

### Manage KV Storage
```bash
# List all keys in KV namespace
wrangler kv:key list --namespace-id 51b1428262d34206950d75a93426af02

# Delete expired/stale keys
wrangler kv:key delete <key> --namespace-id 51b1428262d34206950d75a93426af02

# Bulk operations
wrangler kv:bulk put bulk-upload.json --namespace-id 51b1428262d34206950d75a93426af02
wrangler kv:bulk delete bulk-delete.json --namespace-id 51b1428262d34206950d75a93426af02
```

### Worker Management
```bash
# List all workers
wrangler deployments list

# Delete worker (CAUTION: This will remove the worker)
wrangler delete gdrive-browser

# Rename worker
wrangler deployments rename old-name new-name
```

## 🐛 Troubleshooting Commands

### Debug Local Development
```bash
# Run with verbose logging
wrangler dev --verbose

# Check for syntax errors
node --check worker.js

# Test configuration
wrangler dev --dry-run
```

### Test API Endpoints
```bash
# Test health check
curl https://gdrive-browser.ltimindtree.workers.dev

# Test CORS headers
curl -H "Origin: https://example.com" \
     -H "Access-Control-Request-Method: POST" \
     -X OPTIONS \
     https://gdrive-browser.ltimindtree.workers.dev/api/upload-config

# Test with sample data (will fail but shows error handling)
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{"test": "data"}' \
     https://gdrive-browser.ltimindtree.workers.dev/api/list-files
```

### Network Debugging
```bash
# Test connectivity to Cloudflare
ping workers.dev
traceroute gdrive-browser.ltimindtree.workers.dev

# Check DNS resolution
nslookup gdrive-browser.ltimindtree.workers.dev

# Test with different user agents
curl -A "Mozilla/5.0" https://gdrive-browser.ltimindtree.workers.dev
```

### Configuration Validation
```bash
# Validate wrangler configuration
wrangler dev --dry-run

# Check for missing dependencies
npm audit
npm outdated

# Verify file structure
find . -name "*.js" -o -name "*.json" | head -10
```

## 🔄 Update & Maintenance

### Update Dependencies
```bash
# Update project dependencies
npm update

# Update Wrangler CLI
npm update -g wrangler

# Check for security vulnerabilities
npm audit fix
```

### Code Updates
```bash
# After making code changes, test locally
npm run dev

# Then deploy
npm run deploy

# Monitor for errors
wrangler tail
```

### Backup Configuration
```bash
# Backup wrangler configuration
cp wrangler.jsonc wrangler.jsonc.backup

# Backup environment variables (document them separately)
echo "ENCRYPTION_KEY=your-key-here" > .env.backup
echo "KV_NAMESPACE_ID=51b1428262d34206950d75a93426af02" >> .env.backup
```

## 🚨 Emergency Commands

### Quick Rollback
```bash
# Get latest deployment ID
wrangler deployments list | head -2

# Rollback immediately
wrangler rollback <deployment-id>
```

### Emergency Shutdown
```bash
# Temporarily disable worker (routes traffic to origin)
# Note: Requires custom domain setup for this to work
wrangler route delete your-domain.com/*

# Or delete the worker entirely
wrangler delete gdrive-browser
```

### Data Cleanup
```bash
# Clear all KV data (CAUTION: Permanent)
wrangler kv:key list --namespace-id 51b1428262d34206950d75a93426af02 | \
xargs -I {} wrangler kv:key delete {} --namespace-id 51b1428262d34206950d75a93426af02

# Or delete entire namespace (CAUTION: Permanent)
wrangler kv:namespace delete CONFIGS
```

## 📝 Command Summary Table

| Category | Command | Purpose |
|----------|---------|---------|
| **Setup** | `npm install -g wrangler` | Install Wrangler CLI |
| **Auth** | `wrangler login` | Authenticate with Cloudflare |
| **Storage** | `wrangler kv:namespace create CONFIGS` | Create KV storage |
| **Dev** | `npm run dev` | Start local development |
| **Deploy** | `npm run deploy` | Deploy to production |
| **Monitor** | `wrangler tail` | View real-time logs |
| **Debug** | `wrangler dev --verbose` | Debug with verbose output |
| **Rollback** | `wrangler rollback <id>` | Rollback deployment |
| **Cleanup** | `wrangler delete gdrive-browser` | Remove worker |

## 🔗 Quick Reference

### One-Time Setup
```bash
npm install -g wrangler
wrangler login
wrangler kv:namespace create CONFIGS
# Edit wrangler.jsonc with actual IDs
npm run dev  # Test locally
npm run deploy  # Deploy to production
```

### Daily Development
```bash
npm run dev          # Start development
wrangler tail        # Monitor logs
npm run deploy       # Deploy changes
```

### Troubleshooting
```bash
wrangler tail --level=error    # Error logs only
curl -I https://your-worker.workers.dev  # Health check
wrangler dev --verbose         # Debug mode
```

---

## ⚡ Quick Start (Copy & Paste)

```bash
# Complete setup in one go (run these commands in order):
npm install -g wrangler
wrangler login
wrangler kv:namespace create CONFIGS
cd "D:\multicloud aggregator"
npm install
npm run dev
# Test locally, then:
npm run deploy
wrangler tail
```

**Note**: Replace `51b1428262d34206950d75a93426af02` with your actual KV namespace ID in all commands.

**Important**: Keep your `ENCRYPTION_KEY` and KV namespace ID secure and never commit them to version control.
