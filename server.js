import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAction } from './bot.js';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Add CORS support
app.use(cors());

// Add basic request logging
app.use((req, res, next) => {
  console.log(`📡 SERVER: ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let runningPlatforms = new Set();

// Store SSE connections for real-time progress updates
const progressConnections = new Map(); // sessionId -> response object

app.get('/health', (req, res) => res.json({ ok: true }));

// Server-Sent Events endpoint for real-time progress updates
app.get('/progress/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Store connection for this session
  progressConnections.set(sessionId, res);
  
  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ 
    type: 'connected', 
    message: 'Progress tracking connected',
    timestamp: new Date().toISOString()
  })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    progressConnections.delete(sessionId);
    console.log(`📊 Progress connection closed for session: ${sessionId}`);
  });

  console.log(`📊 Progress connection established for session: ${sessionId}`);
});

// Function to send progress updates to connected clients
function sendProgressUpdate(sessionId, progressData) {
  const connection = progressConnections.get(sessionId);
  console.log(`📊 Sending progress update to ${sessionId}:`, progressData);
  
  if (connection) {
    try {
      const payload = {
        type: 'progress',
        ...progressData,
        timestamp: new Date().toISOString()
      };
      
      console.log(`📡 SSE payload:`, payload);
      connection.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      console.log(`❌ Error sending progress update to ${sessionId}:`, error.message);
      progressConnections.delete(sessionId);
    }
  } else {
    console.log(`⚠️ No connection found for session ${sessionId}`);
  }
}

app.post('/run', async (req, res) => {
  console.log('🔥 === POST /run ENDPOINT HIT ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('Received request:', {
    action: req.body?.action,
    platform: req.body?.platform,
    sessionName: req.body?.sessionName,
    headful: req.body?.headful
  });
  
  // Extract platform from request body
  const requestPlatform = req.body?.platform;
  
  if (!requestPlatform) {
    return res.status(400).json({ ok: false, error: 'Platform is required' });
  }
  
  if (runningPlatforms.has(requestPlatform)) {
    console.log(`Request blocked - ${requestPlatform} job already running`);
    return res.status(409).json({ ok: false, error: `A ${requestPlatform} job is already running. Please wait.` });
  }
  
  const {
    platform,
    action,
    url,
    comment,
    username: requestUsername,
    password: requestPassword,
    headful = false,
    sessionName = 'default',
    searchCriteria,
    maxPosts = 5,
    useAI = false,
    aiContext = '',
    likePost = false,
    assistantId,
    progressSessionId, // New field for progress tracking
  } = req.body || {};

  // Use environment variables if username/password not provided in request (Threads only)
  const envUser = process.env.THREADS_USERNAME || process.env.INSTAGRAM_USERNAME;
  const envPass = process.env.THREADS_PASSWORD || process.env.INSTAGRAM_PASSWORD;
  const username = requestUsername || envUser;
  const password = requestPassword || envPass;

  console.log(`📡 SERVER: Using username: ${username} for session: ${sessionName}`);

  try {
    runningPlatforms.add(requestPlatform);
    console.log('🚀 SERVER: About to call runAction');
    console.log('Starting runAction with:', { action, platform, sessionName, headful });
    console.log('🚀 SERVER: Calling runAction now...');
    
    const result = await runAction({
      platform,
      action,
      url,
      comment,
      username,
      password,
      headful: Boolean(headful),
      sessionName: sessionName || 'default',
      searchCriteria,
      maxPosts: parseInt(maxPosts, 10),
      useAI: Boolean(useAI),
      aiContext: aiContext || '',
      likePost: Boolean(likePost),
      assistantId,
      progressSessionId,
      sendProgress: progressSessionId ? (data) => sendProgressUpdate(progressSessionId, data) : null
    });
    
    console.log('runAction completed with result:', { ok: result.ok, message: result.message });
    res.json(result);
  } catch (err) {
    console.error('Server error details:', {
      message: err.message,
      name: err.name,
      stack: err.stack,
      toString: err.toString()
    });
    res.status(400).json({ ok: false, error: err.message || err.toString() || String(err) });
  } finally {
    console.log(`Setting ${requestPlatform} as no longer running`);
    runningPlatforms.delete(requestPlatform);
  }
});

const PORT = process.env.PORT || 3000;

// Add error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
  console.log(`UI server listening on http://localhost:${PORT}`);
  console.log('Server started successfully, ready to handle requests');
});


