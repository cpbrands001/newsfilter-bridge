const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from environment variables
const NEWSFILTER_WS_URL = process.env.NEWSFILTER_WS_URL;
const NEWSFILTER_API_KEY = process.env.NEWSFILTER_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'your-secret-token';

let ws = null;
let reconnectInterval = 5000;
let isConnected = false;

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'running',
        connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

// Connect to Newsfilter.io websocket
function connectToNewsfilter() {
    try {
        console.log('Connecting to Newsfilter.io websocket...');
        
        const wsUrl = `${NEWSFILTER_WS_URL}?apikey=${NEWSFILTER_API_KEY}`;
        
        ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log('✅ Connected to Newsfilter.io websocket');
            isConnected = true;
        });

        ws.on('message', async (data) => {
            try {
                const newsData = JSON.parse(data.toString());
                console.log('📰 Received news:', newsData.headline || newsData.title || 'No title');
                
                await forwardToN8n(newsData);
                
            } catch (error) {
                console.error('❌ Error processing message:', error);
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`❌ Websocket closed: ${code} - ${reason}`);
            isConnected = false;
            setTimeout(connectToNewsfilter, reconnectInterval);
        });

        ws.on('error', (error) => {
            console.error('❌ Websocket error:', error);
            isConnected = false;
        });

    } catch (error) {
        console.error('❌ Failed to connect:', error);
        setTimeout(connectToNewsfilter, reconnectInterval);
    }
}

// Forward news data to n8n webhook
async function forwardToN8n(newsData) {
    try {
        const payload = {
            ...newsData,
            bridge_timestamp: new Date().toISOString(),
            source: 'newsfilter-bridge'
        };

        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BRIDGE_SECRET}`,
                'User-Agent': 'Newsfilter-Bridge/1.0'
            },
            timeout: 10000
        });

        console.log('✅ Forwarded to n8n:', response.status);
        
    } catch (error) {
        console.error('❌ Failed to forward to n8n:', error.message);
    }
}

// Start the bridge
app.listen(PORT, () => {
    console.log(`🚀 Newsfilter Bridge running on port ${PORT}`);
    connectToNewsfilter();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down gracefully...');
    if (ws) {
        ws.close();
    }
    process.exit(0);
});
