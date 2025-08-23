#!/bin/zsh
cd "/Users/mbp/Desktop/Threads Puppet"

# Kill any existing Node.js processes to ensure fresh start
echo "🔄 Killing existing Node.js processes..."
pkill -f "node" 2>/dev/null || true
sleep 3

# Start the server with latest code
echo "🚀 Starting server with latest code..."
node server.js &
SERVER_PID=$!

# Wait a moment for server to start
sleep 2

# Open Chrome to the app
echo "🌐 Opening Chrome..."
open -a "Google Chrome" http://localhost:3000

# Keep the script running and show server logs
echo "📊 Server started! Press Ctrl+C to stop."
wait $SERVER_PID

