// ====== Enhanced Cloudflare Worker - Google Drive Browser ======

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
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ===== CORRECTED: Direct Download Proxy Endpoint =====
    if (url.pathname.startsWith('/download/')) {
      try {
        // Extract download token from URL: /download/{sessionId}/{fileId}/{filename}
        const pathParts = url.pathname.split('/').filter(p => p);

        if (pathParts.length < 3) {
          return new Response('Invalid download URL', { status: 400 });
        }

        const sessionId = pathParts[1];
        const fileId = pathParts[2];
        const filename = decodeURIComponent(pathParts[3] || 'download');

        // FIXED: Get access token using helper function with env
        const encryptedConfig = await env.CONFIGS.get(sessionId);

        if (!encryptedConfig) {
          return new Response('Session expired or invalid. Please generate a new download link.', {
            status: 401,
            headers: { 'Content-Type': 'text/plain' }
          });
        }

        const configText = await decryptData(encryptedConfig, env.ENCRYPTION_KEY);
        const config = parseINI(configText);

        // Get first Google Drive remote
        const driveRemotes = Object.entries(config).filter(([, cfg]) => cfg.type === 'drive');
        if (driveRemotes.length === 0) {
          return new Response('No Google Drive remote found', { status: 404 });
        }

        const [remoteName, remote] = driveRemotes[0];
        const tokenData = JSON.parse(remote.token);

        let accessToken = tokenData.access_token;

        // Check if token expired and refresh if needed
        if (tokenData.expiry && new Date(tokenData.expiry) < new Date()) {
          // Use client credentials from config
          const clientId = remote.client_id || '202264815644.apps.googleusercontent.com';
          const clientSecret = remote.client_secret || 'X4Z3ca8xfWDb1Voo-F9a7ZxJ';

          accessToken = await refreshGoogleToken(tokenData.refresh_token, clientId, clientSecret);

          // Update stored config
          tokenData.access_token = accessToken;
          tokenData.expiry = new Date(Date.now() + 3600000).toISOString();
          remote.token = JSON.stringify(tokenData);

          const newConfigText = stringifyIni(config);
          const newEncrypted = await encryptData(newConfigText, env.ENCRYPTION_KEY);
          await env.CONFIGS.put(sessionId, newEncrypted, { expirationTtl: 86400 });
        }

        // Stream file from Google Drive through Cloudflare
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

        const driveResponse = await fetch(driveUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Range': request.headers.get('Range') || '' // Support range requests for video streaming
          }
        });

        if (!driveResponse.ok) {
          const errorText = await driveResponse.text();
          console.error('Drive API error:', errorText);
          return new Response(`File not found or access denied: ${errorText}`, {
            status: driveResponse.status
          });
        }

        // Get file metadata for proper headers
        const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`;
        const metaResponse = await fetch(metaUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        let metadata = { name: filename, mimeType: 'application/octet-stream', size: '' };
        if (metaResponse.ok) {
          metadata = await metaResponse.json();
        }

        // Build response headers
        const responseHeaders = {
          'Content-Type': metadata.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(metadata.name || filename)}"`,
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff'
        };

        // Add Content-Length if available
        if (metadata.size) {
          responseHeaders['Content-Length'] = metadata.size;
        }

        // Copy range headers if present (for video streaming)
        if (driveResponse.headers.get('Content-Range')) {
          responseHeaders['Content-Range'] = driveResponse.headers.get('Content-Range');
          responseHeaders['Accept-Ranges'] = 'bytes';
        }

        // Stream response with proper headers
        return new Response(driveResponse.body, {
          status: driveResponse.status,
          headers: responseHeaders
        });

      } catch (err) {
        console.error('Download error:', err);
        return new Response(`Download failed: ${err.message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
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
          expirationTtl: 86400 // 24 hours for download links
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

    // ===== ENDPOINT 2: Get All Direct Links =====
    if (url.pathname === '/api/get-direct-link' && request.method === 'POST') {
      try {
        const { sessionId, remoteName, fileId, fileName } = await request.json();

        if (!sessionId || !fileId) {
          return jsonResponse({ error: 'Missing required parameters' }, 400, corsHeaders);
        }

        // Generate Cloudflare direct download URL
        const cloudflareDownloadUrl = `${url.origin}/download/${sessionId}/${fileId}/${encodeURIComponent(fileName || 'download')}`;

        // Get file metadata for additional links
        const accessToken = await getAccessToken(sessionId, remoteName, env);

        const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,webContentLink,webViewLink`;
        const metaResponse = await fetch(metaUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!metaResponse.ok) {
          throw new Error('Failed to get file info');
        }

        const fileData = await metaResponse.json();

        // Construct API direct link (temporary)
        const apiDirectLink = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&access_token=${accessToken}`;

        return jsonResponse({
          success: true,
          cloudflareDownloadUrl: cloudflareDownloadUrl,
          publicShareLink: fileData.webContentLink || 'Not available (file not public)',
          apiDirectLink: apiDirectLink,
          fileId: fileData.id,
          fileName: fileData.name,
          mimeType: fileData.mimeType,
          size: fileData.size,
          expiresIn: '24 hours'
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ===== ENDPOINT 3: List Google Drive files =====
    if (url.pathname === '/api/list-files' && request.method === 'POST') {
      try {
        const { sessionId, remoteName, folderId = 'root' } = await request.json();

        const accessToken = await getAccessToken(sessionId, remoteName, env);
        const files = await listGoogleDriveFiles(accessToken, folderId);

        return jsonResponse({
          success: true,
          folderId,
          files
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ===== NEW ENDPOINT 3: Get Direct Download Link =====
    if (url.pathname === '/api/get-direct-link' && request.method === 'POST') {
      try {
        const { sessionId, remoteName, fileId } = await request.json();

        const accessToken = await getAccessToken(sessionId, remoteName, env);

        // Fetch file metadata including webContentLink
        const fileUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,webContentLink`;
        const response = await fetch(fileUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!response.ok) {
          throw new Error(`Failed to get file info: ${response.status}`);
        }

        const fileData = await response.json();

        // Construct direct download link
        const directLink = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&access_token=${accessToken}`;

        return jsonResponse({
          success: true,
          fileId: fileData.id,
          fileName: fileData.name,
          webContentLink: fileData.webContentLink, // Public shareable link
          directDownloadLink: directLink, // Direct API download (temporary)
          mimeType: fileData.mimeType,
          size: fileData.size
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ===== NEW ENDPOINT 4: Rename File =====
    if (url.pathname === '/api/rename-file' && request.method === 'POST') {
      try {
        const { sessionId, remoteName, fileId, newName } = await request.json();

        if (!newName || newName.trim() === '') {
          return jsonResponse({ error: 'New name is required' }, 400, corsHeaders);
        }

        const accessToken = await getAccessToken(sessionId, remoteName, env);

        // Update file name using PATCH
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: newName.trim()
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || 'Rename failed');
        }

        const updatedFile = await response.json();

        return jsonResponse({
          success: true,
          file: {
            id: updatedFile.id,
            name: updatedFile.name,
            mimeType: updatedFile.mimeType
          }
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ===== NEW ENDPOINT 5: Move/Organize File =====
    if (url.pathname === '/api/move-file' && request.method === 'POST') {
      try {
        const { sessionId, remoteName, fileId, targetFolderId } = await request.json();

        if (!targetFolderId) {
          return jsonResponse({ error: 'Target folder ID is required' }, 400, corsHeaders);
        }

        const accessToken = await getAccessToken(sessionId, remoteName, env);

        // First, get current parents
        const fileResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!fileResponse.ok) {
          throw new Error('Failed to get file info');
        }

        const fileData = await fileResponse.json();
        const previousParents = fileData.parents ? fileData.parents.join(',') : '';

        // Move file by updating parents
        const moveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${targetFolderId}&removeParents=${previousParents}&fields=id,name,parents`;

        const moveResponse = await fetch(moveUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({}) // Empty body, params in URL
        });

        if (!moveResponse.ok) {
          const error = await moveResponse.json();
          throw new Error(error.error?.message || 'Move failed');
        }

        const movedFile = await moveResponse.json();

        return jsonResponse({
          success: true,
          file: {
            id: movedFile.id,
            name: movedFile.name,
            parents: movedFile.parents
          }
        }, 200, corsHeaders);

      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // ===== NEW ENDPOINT 6: List All Folders (for move dialog) =====
    if (url.pathname === '/api/list-folders' && request.method === 'POST') {
      try {
        const { sessionId, remoteName } = await request.json();

        const accessToken = await getAccessToken(sessionId, remoteName, env);

        // Query only folders
        const query = "mimeType='application/vnd.google-apps.folder' and trashed=false";
        const url = `https://www.googleapis.com/drive/v3/files?` + new URLSearchParams({
          q: query,
          fields: 'files(id,name,parents)',
          orderBy: 'name',
          pageSize: 1000
        });

        const response = await fetch(url, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!response.ok) {
          throw new Error(`Failed to list folders: ${response.status}`);
        }

        const data = await response.json();

        // Add root folder
        const folders = [
          { id: 'root', name: 'My Drive', parents: [] },
          ...(data.files || [])
        ];

        return jsonResponse({
          success: true,
          folders
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

// ===== Helper: Get and refresh access token =====
async function getAccessToken(sessionId, remoteName, env) {
  const encryptedConfig = await env.CONFIGS.get(sessionId);
  if (!encryptedConfig) {
    throw new Error('Session expired or invalid');
  }

  const configText = await decryptData(encryptedConfig, env.ENCRYPTION_KEY);
  const config = parseINI(configText);

  const remote = config[remoteName];
  if (!remote || remote.type !== 'drive') {
    throw new Error('Remote not found');
  }

  const tokenData = JSON.parse(remote.token);

  // Check if token expired and refresh if needed
  let accessToken = tokenData.access_token;
  if (tokenData.expiry && new Date(tokenData.expiry) < new Date()) {
    // Use client credentials from config
    const clientId = remote.client_id || '202264815644.apps.googleusercontent.com';
    const clientSecret = remote.client_secret || 'X4Z3ca8xfWDb1Voo-F9a7ZxJ';

    accessToken = await refreshGoogleToken(tokenData.refresh_token, clientId, clientSecret);

    // Update stored config with new token
    tokenData.access_token = accessToken;
    tokenData.expiry = new Date(Date.now() + 3600000).toISOString();
    remote.token = JSON.stringify(tokenData);

    const newConfigText = stringifyIni(config);
    const newEncrypted = await encryptData(newConfigText, env.ENCRYPTION_KEY);
    await env.CONFIGS.put(sessionId, newEncrypted, { expirationTtl: 86400 });
  }

  return accessToken;
}

// ===== Google Drive API Functions =====
async function listGoogleDriveFiles(accessToken, folderId = 'root') {
  const query = `'${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?` + new URLSearchParams({
    q: query,
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink)',
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

// ===== Enhanced Frontend HTML =====
const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google Drive Browser - Enhanced</title>
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
    .upload-panel h1::after {
      content: " ✨";
      font-size: 16px;
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
    .file-actions {
      display: flex;
      gap: 8px;
    }
    .file-actions button {
      padding: 6px 12px;
      font-size: 12px;
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
    .success {
      background: #e8f5e9;
      color: #2e7d32;
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 20px;
    }

    /* Modal Styles */
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.5);
      animation: fadeIn 0.3s;
    }
    .modal-content {
      background-color: white;
      margin: 10% auto;
      padding: 30px;
      border-radius: 12px;
      width: 90%;
      max-width: 500px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      animation: slideDown 0.3s;
    }
    .modal-header {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 20px;
      color: #202124;
    }
    .modal-body {
      margin-bottom: 20px;
    }
    .modal-body input,
    .modal-body select {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      margin-top: 10px;
    }
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .close {
      color: #aaa;
      float: right;
      font-size: 28px;
      font-weight: bold;
      cursor: pointer;
      line-height: 20px;
    }
    .close:hover {
      color: #000;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideDown {
      from { transform: translateY(-50px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .link-display {
      background: #f8f9fa;
      padding: 12px;
      border-radius: 6px;
      word-break: break-all;
      font-family: monospace;
      font-size: 12px;
      margin: 10px 0;
      border: 1px solid #dee2e6;
      max-height: 200px;
      overflow-y: auto;
    }

    .badge {
      background: #ff6b35;
      color: white;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      margin-left: 8px;
      vertical-align: middle;
    }

    .link-type {
      font-weight: 600;
      color: #667eea;
      margin-top: 15px;
      margin-bottom: 5px;
      font-size: 14px;
    }

    .copy-btn {
      width: 100%;
      margin-top: 5px;
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
        <h2>📁 My Google Drive <span class="badge">Cloudflare CDN</span></h2>
        <p style="font-size: 12px; opacity: 0.9; margin-top: 5px;">✨ Direct links • Rename • Move • Cloudflare Proxy</p>
        <button onclick="resetUpload()" style="background: rgba(255,255,255,0.2); margin-top: 10px;">Upload Different Config</button>
      </div>
      <div id="breadcrumb" class="breadcrumb"></div>
      <div id="fileList" class="file-list"></div>
    </div>

    <!-- Rename Modal -->
    <div id="renameModal" class="modal">
      <div class="modal-content">
        <span class="close" onclick="closeModal('renameModal')">&times;</span>
        <div class="modal-header">📝 Rename File</div>
        <div class="modal-body">
          <label>New name:</label>
          <input type="text" id="renameInput" placeholder="Enter new name">
        </div>
        <div class="modal-footer">
          <button class="secondary" onclick="closeModal('renameModal')">Cancel</button>
          <button class="success" onclick="performRename()">Rename</button>
        </div>
      </div>
    </div>

    <!-- Move Modal -->
    <div id="moveModal" class="modal">
      <div class="modal-content">
        <span class="close" onclick="closeModal('moveModal')">&times;</span>
        <div class="modal-header">📂 Move File</div>
        <div class="modal-body">
          <label>Select destination folder:</label>
          <select id="folderSelect"></select>
        </div>
        <div class="modal-footer">
          <button class="secondary" onclick="closeModal('moveModal')">Cancel</button>
          <button class="success" onclick="performMove()">Move</button>
        </div>
      </div>
    </div>

  <!-- Direct Link Modal with ALL THREE LINKS -->
  <div id="linkModal" class="modal">
    <div class="modal-content">
      <span class="close" onclick="closeModal('linkModal')">&times;</span>
      <div class="modal-header">🔗 Direct Download Links</div>
      <div class="modal-body">

        <!-- CLOUDFLARE LINK (RECOMMENDED) -->
        <div class="link-type">🚀 Cloudflare Direct Download <span class="badge">RECOMMENDED</span></div>
        <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
          ✅ Permanent link valid for 24 hours<br>
          ✅ No token exposure - Secure!<br>
          ✅ Works in browsers, IDM, aria2, streaming apps
        </p>
        <div class="link-display" id="cloudflareLink">Generating...</div>
        <button onclick="copyToClipboard('cloudflareLink')" class="copy-btn warning">📋 Copy Cloudflare Link</button>

        <!-- PUBLIC SHARE LINK -->
        <div class="link-type" style="margin-top: 20px;">📎 Google Drive Public Link</div>
        <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
          Shareable Google Drive link (requires file to be public)
        </p>
        <div class="link-display" id="publicLink">Loading...</div>
        <button onclick="copyToClipboard('publicLink')" class="copy-btn">📋 Copy Public Link</button>

        <!-- API LINK (TEMPORARY) -->
        <div class="link-type" style="margin-top: 20px;">⚠️ Direct API Link (Temporary)</div>
        <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
          Includes access token - expires in 1 hour
        </p>
        <div class="link-display" id="apiLink">Loading...</div>
        <button onclick="copyToClipboard('apiLink')" class="copy-btn secondary">📋 Copy API Link</button>

        <p style="margin-top: 15px; font-size: 12px; color: #666; padding: 10px; background: #fff3cd; border-radius: 6px;">
          💡 <strong>Tip:</strong> Use the Cloudflare link for best security and performance!
        </p>

      </div>
      <div class="modal-footer">
        <button onclick="closeModal('linkModal')">Close</button>
      </div>
    </div>
  </div>

    <div id="notification" class="success" style="display:none; position: fixed; top: 20px; right: 20px; z-index: 1001; min-width: 300px;"></div>

  </div>

  <script>
    let sessionId = null;
    let remoteName = null;
    let folderStack = [{ id: 'root', name: 'My Drive' }];
    let currentFileForAction = null;
    let allFolders = [];

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

        // Load folders for move functionality
        await loadAllFolders();

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

      const infoDiv = document.createElement('div');
      infoDiv.className = 'file-info';
      infoDiv.innerHTML = \`
        <div class="file-name">\${escapeHtml(file.name)}</div>
        <div class="file-meta">\${size ? size + ' • ' : ''}Modified \${formatDate(file.modifiedTime)}</div>
      \`;

      if (isFolder) {
        infoDiv.onclick = () => {
          folderStack.push({ id: file.id, name: file.name });
          loadFiles(file.id);
        };
      } else {
        infoDiv.onclick = () => window.open(file.webViewLink, '_blank');
      }

      const iconDiv = document.createElement('div');
      iconDiv.className = 'file-icon';
      iconDiv.textContent = icon;

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'file-actions';

      if (!isFolder) {
        const cfLinkBtn = document.createElement('button');
        cfLinkBtn.textContent = '⚡ CF Link';
        cfLinkBtn.className = 'warning';
        cfLinkBtn.title = 'Get Cloudflare direct download link';
        cfLinkBtn.onclick = () => showCloudflareLink(file);
        actionsDiv.appendChild(cfLinkBtn);
      }

      const renameBtn = document.createElement('button');
      renameBtn.textContent = '📝 Rename';
      renameBtn.onclick = () => showRenameModal(file);
      actionsDiv.appendChild(renameBtn);

      const moveBtn = document.createElement('button');
      moveBtn.textContent = '📂 Move';
      moveBtn.onclick = () => showMoveModal(file);
      actionsDiv.appendChild(moveBtn);

      item.appendChild(iconDiv);
      item.appendChild(infoDiv);
      item.appendChild(actionsDiv);

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

    // ===== Cloudflare Direct Link Functionality =====
    async function showCloudflareLink(file) {
      try {
        showNotification('⏳ Generating links...', 'success');

        const response = await fetch('/api/get-direct-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId,
            remoteName: remoteName,
            fileId: file.id,
            fileName: file.name
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to generate links');
        }

        // Update modal with all three links
        document.getElementById('cloudflareLink').textContent = data.cloudflareDownloadUrl;
        document.getElementById('publicLink').textContent = data.publicShareLink;
        document.getElementById('apiLink').textContent = data.apiDirectLink;

        document.getElementById('linkModal').style.display = 'block';
        showNotification('✅ Links generated!', 'success');

      } catch (err) {
        showNotification('❌ ' + err.message, 'error');
      }
    }

    // ===== Rename Functionality =====
    function showRenameModal(file) {
      currentFileForAction = file;
      document.getElementById('renameInput').value = file.name;
      document.getElementById('renameModal').style.display = 'block';
    }

    async function performRename() {
      const newName = document.getElementById('renameInput').value.trim();

      if (!newName) {
        showNotification('❌ Name cannot be empty', 'error');
        return;
      }

      try {
        const response = await fetch('/api/rename-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            remoteName,
            fileId: currentFileForAction.id,
            newName: newName
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Rename failed');
        }

        closeModal('renameModal');
        showNotification('✅ File renamed successfully!', 'success');

        // Reload current folder
        const currentFolder = folderStack[folderStack.length - 1];
        loadFiles(currentFolder.id);

      } catch (err) {
        showNotification('❌ ' + err.message, 'error');
      }
    }

    // ===== Move Functionality =====
    async function loadAllFolders() {
      try {
        const response = await fetch('/api/list-folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            remoteName
          })
        });

        const data = await response.json();

        if (response.ok) {
          allFolders = data.folders;
        }

      } catch (err) {
        console.error('Failed to load folders:', err);
      }
    }

    function showMoveModal(file) {
      currentFileForAction = file;

      const select = document.getElementById('folderSelect');
      select.innerHTML = '';

      allFolders.forEach(folder => {
        if (folder.id !== file.id) { // Don't allow moving to itself
          const option = document.createElement('option');
          option.value = folder.id;
          option.textContent = folder.name;
          select.appendChild(option);
        }
      });

      document.getElementById('moveModal').style.display = 'block';
    }

    async function performMove() {
      const targetFolderId = document.getElementById('folderSelect').value;

      if (!targetFolderId) {
        showNotification('❌ Please select a folder', 'error');
        return;
      }

      try {
        const response = await fetch('/api/move-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            remoteName,
            fileId: currentFileForAction.id,
            targetFolderId: targetFolderId
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Move failed');
        }

        closeModal('moveModal');
        showNotification('✅ File moved successfully!', 'success');

        // Reload current folder
        const currentFolder = folderStack[folderStack.length - 1];
        loadFiles(currentFolder.id);

      } catch (err) {
        showNotification('❌ ' + err.message, 'error');
      }
    }

    // ===== Helper Functions =====
    function closeModal(modalId) {
      document.getElementById(modalId).style.display = 'none';
      currentFileForAction = null;
    }

    function showNotification(message, type = 'success') {
      const notification = document.getElementById('notification');
      notification.textContent = message;
      notification.className = type;
      notification.style.display = 'block';

      setTimeout(() => {
        notification.style.display = 'none';
      }, 3000);
    }

    function copyToClipboard(elementId) {
      const text = document.getElementById(elementId).textContent;
      navigator.clipboard.writeText(text).then(() => {
        showNotification('✅ Copied to clipboard!', 'success');
      }).catch(() => {
        showNotification('❌ Failed to copy', 'error');
      });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Close modal when clicking outside
    window.onclick = function(event) {
      if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;
