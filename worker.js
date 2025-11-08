// ====== Cloudflare Worker - Google Drive Browser ======

// Simple INI parser for Cloudflare Workers
function parseINI(text) {
  const config = {};
  let currentSection = null;

  const lines = text.split('\n').map(line => line.trim());

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    // Section header
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1);
      config[currentSection] = {};
      continue;
    }

    // Key-value pair
    if (currentSection && line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').trim();
      config[currentSection][key.trim()] = value;
    }
  }

  return config;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for browser access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ===== ENDPOINT 1: Upload rclone config =====
    if (url.pathname === '/api/upload-config' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('config');

        if (!file) {
          return jsonResponse({ error: 'No file uploaded' }, 400, corsHeaders);
        }

        // Read file content
        const configText = await file.text();

        // Parse rclone config (INI format)
        const config = parseINI(configText);

        // Find Google Drive remotes
        const gdriveRemotes = Object.entries(config)
          .filter(([name, cfg]) => cfg.type === 'drive')
          .map(([name, cfg]) => ({
            name,
            hasToken: !!cfg.token,
            hasCustomCredentials: !!(cfg.client_id && cfg.client_secret)
          }));

        if (gdriveRemotes.length === 0) {
          return jsonResponse({
            error: 'No Google Drive remotes found in config'
          }, 400, corsHeaders);
        }

        // Generate session ID
        const sessionId = crypto.randomUUID();

        // Store encrypted config in KV (or R2 for larger files)
        const encryptedConfig = await encryptData(configText, env.ENCRYPTION_KEY);
        await env.CONFIGS.put(sessionId, encryptedConfig, {
          expirationTtl: 3600 // 1 hour expiry
        });

        return jsonResponse({
          success: true,
          sessionId,
          remotes: gdriveRemotes
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ===== ENDPOINT 2: List Google Drive files =====
    if (url.pathname === '/api/list-files' && request.method === 'POST') {
      try {
        const { sessionId, remoteName, folderId = 'root' } = await request.json();

        // Retrieve config from KV
        const encryptedConfig = await env.CONFIGS.get(sessionId);
        if (!encryptedConfig) {
          return jsonResponse({ error: 'Session expired or invalid' }, 401, corsHeaders);
        }

        const configText = await decryptData(encryptedConfig, env.ENCRYPTION_KEY);
        const config = parseINI(configText);

        // Get specific remote
        const remote = config[remoteName];
        if (!remote || remote.type !== 'drive') {
          return jsonResponse({ error: `Remote '${remoteName}' not found or not a Google Drive remote. Available remotes: ${Object.keys(config).join(', ')}` }, 404, corsHeaders);
        }

        // Parse token
        let tokenData;
        try {
          tokenData = JSON.parse(remote.token);
        } catch (tokenErr) {
          return jsonResponse({ error: `Invalid token format: ${remote.token.substring(0, 100)}...` }, 400, corsHeaders);
        }

        // ===== KEY FIX: Use client credentials from config =====
        const clientId = remote.client_id || '202264815644.apps.googleusercontent.com';
        const clientSecret = remote.client_secret || 'X4Z3ca8xfWDb1Voo-F9a7ZxJ';

        // Check if token expired and refresh if needed
        let accessToken = tokenData.access_token;
        if (tokenData.expiry && new Date(tokenData.expiry) < new Date()) {
          try {
            console.log('Token expired, refreshing...');
            accessToken = await refreshGoogleToken(
              tokenData.refresh_token,
              clientId,
              clientSecret
            );

            // Update stored config with new token
            tokenData.access_token = accessToken;
            tokenData.expiry = new Date(Date.now() + 3600000).toISOString();
            remote.token = JSON.stringify(tokenData);

            const newConfigText = stringifyIni(config);
            const newEncrypted = await encryptData(newConfigText, env.ENCRYPTION_KEY);
            await env.CONFIGS.put(sessionId, newEncrypted, { expirationTtl: 3600 });
            console.log('Token refreshed successfully');
          } catch (refreshErr) {
            return jsonResponse({ error: `Token refresh failed: ${refreshErr.message}` }, 500, corsHeaders);
          }
        }

        // Fetch files from Google Drive API
        let files;
        try {
          console.log('Fetching files from Google Drive API...');
          files = await listGoogleDriveFiles(accessToken, folderId);
          console.log(`Fetched ${files.length} files`);
        } catch (apiErr) {
          return jsonResponse({ error: `Google Drive API error: ${apiErr.message}` }, 500, corsHeaders);
        }

        return jsonResponse({
          success: true,
          folderId,
          files
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // Default: Serve HTML frontend
    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
};

// ===== Google Drive API Functions =====
async function listGoogleDriveFiles(accessToken, folderId = 'root') {
  const query = `'${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?` + new URLSearchParams({
    q: query,
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
    orderBy: 'folder,name',
    pageSize: 1000
  });

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Drive API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.files || [];
}

async function refreshGoogleToken(refreshToken, clientId, clientSecret) {
  console.log('Refreshing token with client_id:', clientId);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`No access token in refresh response: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ===== Encryption Functions =====
async function encryptData(text, keyString) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const keyData = encoder.encode(keyString);

  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', keyData),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

async function decryptData(encryptedB64, keyString) {
  const combined = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const encoder = new TextEncoder();
  const keyData = encoder.encode(keyString);

  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', keyData),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

// ===== INI Stringify =====
function stringifyIni(config) {
  let result = '';
  for (const [section, data] of Object.entries(config)) {
    if (typeof data === 'object' && data !== null) {
      result += `[${section}]\n`;
      for (const [key, value] of Object.entries(data)) {
        result += `${key} = ${value}\n`;
      }
      result += '\n';
    }
  }
  return result;
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

// ===== Frontend HTML =====
const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google Drive Browser - Rclone Config Upload</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    .upload-panel {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    .upload-panel h1 {
      color: #667eea;
      margin-bottom: 10px;
    }
    .upload-panel p {
      color: #666;
      margin-bottom: 30px;
    }
    .upload-zone {
      border: 3px dashed #667eea;
      border-radius: 12px;
      padding: 60px 20px;
      margin-bottom: 20px;
      background: #f8f9ff;
      cursor: pointer;
      transition: all 0.3s;
    }
    .upload-zone:hover {
      border-color: #764ba2;
      background: #f0f2ff;
    }
    .upload-zone.dragover {
      border-color: #00c853;
      background: #e8f5e9;
    }
    input[type="file"] {
      display: none;
    }
    button {
      background: #667eea;
      color: white;
      border: none;
      padding: 12px 30px;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      transition: background 0.3s;
    }
    button:hover {
      background: #5568d3;
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .file-browser {
      display: none;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .browser-header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
    }
    .breadcrumb {
      background: #f8f9fa;
      padding: 15px 20px;
      font-size: 14px;
      border-bottom: 1px solid #e0e0e0;
    }
    .breadcrumb span {
      color: #667eea;
      cursor: pointer;
      text-decoration: underline;
    }
    .file-list {
      max-height: 500px;
      overflow-y: auto;
    }
    .file-item {
      display: flex;
      align-items: center;
      padding: 15px 20px;
      border-bottom: 1px solid #f0f0f0;
      cursor: pointer;
      transition: background 0.2s;
    }
    .file-item:hover {
      background: #f8f9fa;
    }
    .file-icon {
      font-size: 28px;
      margin-right: 15px;
    }
    .file-info {
      flex: 1;
    }
    .file-name {
      font-weight: 500;
      color: #202124;
    }
    .file-meta {
      font-size: 12px;
      color: #5f6368;
      margin-top: 4px;
    }
    .loading {
      text-align: center;
      padding: 60px 20px;
      color: #666;
    }
    .error {
      background: #ffebee;
      color: #c62828;
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="upload-panel" id="uploadPanel">
      <h1>📁 Google Drive Browser</h1>
      <p>Upload your rclone.conf file to browse Google Drive</p>

      <div class="upload-zone" id="uploadZone" onclick="document.getElementById('fileInput').click()">
        <div style="font-size: 48px; margin-bottom: 20px;">📤</div>
        <div><strong>Click to upload</strong> or drag and drop</div>
        <div style="font-size: 12px; color: #999; margin-top: 10px;">rclone.conf file</div>
      </div>

      <input type="file" id="fileInput" accept=".conf" onchange="handleFileSelect(event)">
      <div id="uploadError" class="error" style="display:none;"></div>
    </div>

    <div class="file-browser" id="fileBrowser">
      <div class="browser-header">
        <h2>📁 My Google Drive</h2>
        <button onclick="resetUpload()" style="background: rgba(255,255,255,0.2); margin-top: 10px;">Upload Different Config</button>
      </div>
      <div id="breadcrumb" class="breadcrumb"></div>
      <div id="fileList" class="file-list"></div>
    </div>
  </div>

  <script>
    let sessionId = null;
    let remoteName = null;
    let folderStack = [{ id: 'root', name: 'My Drive' }];

    // Drag and drop
    const uploadZone = document.getElementById('uploadZone');
    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => {
      uploadZone.classList.remove('dragover');
    });
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) uploadConfig(file);
    });

    function handleFileSelect(event) {
      const file = event.target.files[0];
      if (file) uploadConfig(file);
    }

    async function uploadConfig(file) {
      const errorDiv = document.getElementById('uploadError');
      errorDiv.style.display = 'none';

      const formData = new FormData();
      formData.append('config', file);

      try {
        const response = await fetch('/api/upload-config', {
          method: 'POST',
          body: formData
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Upload failed');
        }

        if (data.remotes.length === 0) {
          throw new Error('No Google Drive remotes found');
        }

        sessionId = data.sessionId;
        remoteName = data.remotes[0].name;

        // Hide upload panel, show browser
        document.getElementById('uploadPanel').style.display = 'none';
        document.getElementById('fileBrowser').style.display = 'block';

        // Load files
        loadFiles('root');

      } catch (err) {
        errorDiv.textContent = '❌ ' + err.message;
        errorDiv.style.display = 'block';
      }
    }

    async function loadFiles(folderId) {
      const fileListDiv = document.getElementById('fileList');
      fileListDiv.innerHTML = '<div class="loading">Loading files...</div>';

      try {
        const response = await fetch('/api/list-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            remoteName,
            folderId
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to load files');
        }

        const files = data.files;

        if (files.length === 0) {
          fileListDiv.innerHTML = '<div class="loading">📂 Empty folder</div>';
          return;
        }

        // Separate folders and files
        const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
        const regularFiles = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

        fileListDiv.innerHTML = '';
        folders.forEach(file => fileListDiv.appendChild(createFileItem(file, true)));
        regularFiles.forEach(file => fileListDiv.appendChild(createFileItem(file, false)));

        updateBreadcrumb();

      } catch (err) {
        fileListDiv.innerHTML = '<div class="error">' + err.message + '</div>';
      }
    }

    function createFileItem(file, isFolder) {
      const item = document.createElement('div');
      item.className = 'file-item';

      const icon = isFolder ? '📁' : (file.mimeType.includes('image') ? '🖼️' : '📄');
      const size = file.size ? formatBytes(file.size) : '';

      item.innerHTML = \`
        <div class="file-icon">\${icon}</div>
        <div class="file-info">
          <div class="file-name">\${escapeHtml(file.name)}</div>
          <div class="file-meta">\${size ? size + ' • ' : ''}Modified \${formatDate(file.modifiedTime)}</div>
        </div>
      \`;

      if (isFolder) {
        item.onclick = () => {
          folderStack.push({ id: file.id, name: file.name });
          loadFiles(file.id);
        };
      } else {
        item.onclick = () => window.open(file.webViewLink, '_blank');
      }

      return item;
    }

    function updateBreadcrumb() {
      const breadcrumbDiv = document.getElementById('breadcrumb');
      breadcrumbDiv.innerHTML = folderStack.map((folder, i) => {
        if (i === folderStack.length - 1) {
          return \`<strong>\${escapeHtml(folder.name)}</strong>\`;
        }
        return \`<span onclick="navigateTo(\${i})">\${escapeHtml(folder.name)}</span>\`;
      }).join(' / ');
    }

    function navigateTo(index) {
      folderStack = folderStack.slice(0, index + 1);
      const folder = folderStack[folderStack.length - 1];
      loadFiles(folder.id);
    }

    function resetUpload() {
      sessionId = null;
      remoteName = null;
      folderStack = [{ id: 'root', name: 'My Drive' }];
      document.getElementById('uploadPanel').style.display = 'block';
      document.getElementById('fileBrowser').style.display = 'none';
      document.getElementById('fileInput').value = '';
    }

    function formatBytes(bytes) {
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
    }

    function formatDate(dateString) {
      const date = new Date(dateString);
      const now = new Date();
      const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
      if (diffDays === 0) return 'today';
      if (diffDays === 1) return 'yesterday';
      if (diffDays < 7) return diffDays + ' days ago';
      return date.toLocaleDateString();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
