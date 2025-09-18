const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// FinHub Configuration (replacing NewsFilter.io config)
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_WS_URL = process.env.FINNHUB_WS_URL || 'wss://ws.finnhub.io';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const SYMBOLS = process.env.SYMBOLS ? process.env.SYMBOLS.split(',').map(s => s.trim().toUpperCase()) : ['AAPL'];

console.log(`🔧 Configuration loaded:`);
console.log(`   - API Key: ${FINNHUB_API_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`   - Webhook URL: ${N8N_WEBHOOK_URL ? '✅ Set' : '❌ Missing'}`);
console.log(`   - Symbols: ${SYMBOLS.join(', ')}`);

// WebSocket connection management
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000;

// Statistics tracking
let stats = {
    connected: false,
    lastMessage: null,
    messagesReceived: 0,
    messagesSent: 0,
    connectionTime: null,
    errors: 0
};

// Health check endpoint (keep your existing one or replace)
app.get('/health', (req, res) => {
    res.json({
        service: 'finnhub-bridge',
        status: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
        websocket_state: ws ? ws.readyState : null,
        symbols: SYMBOLS,
        stats: stats,
        timestamp: new Date().toISOString()
    });
});

// Statistics endpoint
app.get('/stats', (req, res) => {
    res.json({
        ...stats,
        symbols: SYMBOLS,
        uptime: stats.connectionTime ? Date.now() - stats.connectionTime : 0
    });
});

// Symbol management (useful for dynamic symbol updates)
app.get('/symbols', (req, res) => {
    res.json({ symbols: SYMBOLS });
});

app.post('/symbols/add', (req, res) => {
    const { symbol } = req.body;
    if (symbol && !SYMBOLS.includes(symbol.toUpperCase()) && SYMBOLS.length < 50) {
        const upperSymbol = symbol.toUpperCase();
        SYMBOLS.push(upperSymbol);
        
        // Subscribe to new symbol if connected
        if (ws && ws.readyState === WebSocket.OPEN) {
            subscribeToSymbol(upperSymbol);
        }
        
        res.json({ message: `Added ${upperSymbol}`, symbols: SYMBOLS });
    } else {
        res.status(400).json({ error: 'Invalid symbol or limit reached (50 max)' });
    }
});

app.delete('/symbols/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const index = SYMBOLS.indexOf(symbol);
    
    if (index > -1) {
        SYMBOLS.splice(index, 1);
        
        // Unsubscribe if connected
        if (ws && ws.readyState === WebSocket.OPEN) {
            unsubscribeFromSymbol(symbol);
        }
        
        res.json({ message: `Removed ${symbol}`, symbols: SYMBOLS });
    } else {
        res.status(404).json({ error: 'Symbol not found' });
    }
});

// Manual restart endpoint
app.post('/restart', (req, res) => {
    console.log('🔄 Manual restart requested');
    reconnectAttempts = 0;
    connectToFinnhub();
    res.json({ message: 'Reconnection initiated' });
});

// Send data to N8n (modified from your NewsFilter version)
async function sendToN8n(newsData) {
    if (!N8N_WEBHOOK_URL) {
        console.log('⚠️  No N8n webhook URL configured');
        return;
    }

    try {
        const payload = {
            source: 'finnhub',
            bridge: 'finnhub-n8n-bridge',
            timestamp: new Date().toISOString(),
            ...newsData
        };

        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'FinHub-N8n-Bridge/1.0'
            },
            timeout: 15000
        });

        console.log(`✅ News sent to N8n: ${newsData.headline?.substring(0, 80)}...`);
        stats.messagesSent++;
        
    } catch (error) {
        console.error('❌ Failed to send to N8n:', error.message);
        stats.errors++;
        
        if (error.response) {
            console.error(`   Response status: ${error.response.status}`);
            console.error(`   Response data:`, error.response.data);
        }
    }
}

// Subscribe to a single symbol
function subscribeToSymbol(symbol) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const message = JSON.stringify({
            'type': 'subscribe',
            'symbol': symbol
        });
        ws.send(message);
        console.log(`📰 Subscribed to news for: ${symbol}`);
    }
}

// Unsubscribe from a single symbol
function unsubscribeFromSymbol(symbol) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const message = JSON.stringify({
            'type': 'unsubscribe', 
            'symbol': symbol
        });
        ws.send(message);
        console.log(`📰 Unsubscribed from news for: ${symbol}`);
    }
}

// Subscribe to all configured symbols
function subscribeToAllSymbols() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('⚠️  WebSocket not ready for subscriptions');
        return;
    }

    console.log(`📰 Subscribing to ${SYMBOLS.length} symbols...`);
    SYMBOLS.forEach(symbol => subscribeToSymbol(symbol));
}

// Connect to FinHub WebSocket (replaces your NewsFilter connection)
function connectToFinnhub() {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
        ws = null;
    }

    if (!FINNHUB_API_KEY) {
        console.error('❌ FINNHUB_API_KEY not found in environment variables');
        return;
    }

    const wsUrl = `${FINNHUB_WS_URL}?token=${FINNHUB_API_KEY}`;
    console.log(`🔗 Connecting to FinHub WebSocket...`);

    ws = new WebSocket(wsUrl);
    stats.connected = false;

    ws.on('open', function() {
        console.log('✅ Connected to FinHub WebSocket');
        stats.connected = true;
        stats.connectionTime = Date.now();
        reconnectAttempts = 0;
        
        // Subscribe to symbols after a brief delay
        setTimeout(subscribeToAllSymbols, 1000);
    });

    ws.on('message', function(data) {
        try {
            const message = JSON.parse(data);
            stats.messagesReceived++;
            stats.lastMessage = Date.now();
            
            // Handle FinHub WebSocket message format
            if (message.type === 'news') {
                console.log(`📰 News: ${message.headline?.substring(0, 80)}... [${message.symbol}]`);
                
                // Transform FinHub news format for N8n
                const transformedNews = {
                    type: 'news',
                    symbol: message.symbol,
                    headline: message.headline,
                    summary: message.summary || '',
                    source: message.source || 'FinHub',
                    url: message.url,
                    image: message.image,
                    datetime: message.datetime,
                    category: message.category || 'general',
                    id: message.id || `${message.symbol}-${Date.now()}`,
                    related: message.related || message.symbol
                };
                
                sendToN8n(transformedNews);
                
            } else if (message.type === 'ping') {
                // Respond to FinHub ping
                ws.send(JSON.stringify({ type: 'pong' }));
                
            } else {
                console.log('ℹ️  Other message:', JSON.stringify(message));
            }
            
        } catch (error) {
            console.error('❌ Error parsing message:', error.message);
            console.log('Raw message:', data.toString());
            stats.errors++;
        }
    });

    ws.on('error', function(error) {
        console.error('❌ WebSocket error:', error.message);
        stats.errors++;
        stats.connected = false;
    });

    ws.on('close', function(code, reason) {
        console.log(`🔌 WebSocket closed: ${code} - ${reason || 'No reason'}`);
        stats.connected = false;
        
        // Exponential backoff reconnection
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 30000);
            reconnectAttempts++;
            
            console.log(`🔄 Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            
            setTimeout(() => {
                connectToFinnhub();
            }, delay);
        } else {
            console.error('❌ Max reconnection attempts reached. Manual restart required via /restart endpoint');
        }
    });
}

// Graceful shutdown
function gracefulShutdown(signal) {
    console.log(`🛑 Received ${signal}, shutting down gracefully`);
    if (ws) {
        ws.close(1000, 'Server shutdown');
    }
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 FinHub-N8n Bridge running on port ${PORT}`);
    console.log(`📊 Monitoring ${SYMBOLS.length} symbols: ${SYMBOLS.join(', ')}`);
    
    // Initial connection
    connectToFinnhub();
});

// Keep-alive mechanism (every 30 seconds)
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
    }
}, 30000);
