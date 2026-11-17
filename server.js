#!/usr/bin/env node
/**
 * Simple Bus Arrivals Proxy Server
 *
 * This server:
 * 1. Serves the static HTML file
 * 2. Proxies API requests to TfNSW (bypasses CORS)
 *
 * Usage:
 *   node server.js
 *   Then open: http://localhost:3000
 *
 * Or with custom port:
 *   PORT=8080 node server.js
 */

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 3000;
var API_HOST = 'api.transport.nsw.gov.au';
var API_BASE = '/v1/tp';

// Serve static files
function serveStatic(res, filePath, contentType) {
    fs.readFile(filePath, function(err, data) {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

// Proxy API request to TfNSW
function proxyApi(req, res, apiPath) {
    var apiKey = req.headers['x-api-key'] || '';

    var options = {
        hostname: API_HOST,
        port: 443,
        path: API_BASE + apiPath,
        method: 'GET',
        headers: {
            'Authorization': 'apikey ' + apiKey,
            'Accept': 'application/json',
            'User-Agent': 'BusArrivals/1.0'
        }
    };

    console.log('Proxying: ' + options.path);

    var proxyReq = https.request(options, function(proxyRes) {
        var data = '';

        proxyRes.on('data', function(chunk) {
            data += chunk;
        });

        proxyRes.on('end', function() {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(data);
        });
    });

    proxyReq.on('error', function(err) {
        console.error('Proxy error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.end();
}

// Main request handler
function handleRequest(req, res) {
    var url = req.url;
    console.log(req.method + ' ' + url);

    // Handle OPTIONS (CORS preflight)
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'X-API-Key, Content-Type'
        });
        res.end();
        return;
    }

    // API proxy
    if (url.indexOf('/api/') === 0) {
        var apiPath = url.substring(4); // Remove '/api'
        proxyApi(req, res, apiPath);
        return;
    }

    // Static files
    if (url === '/' || url === '/index.html') {
        serveStatic(res, path.join(__dirname, 'index.html'), 'text/html');
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
}

// Create and start server
var server = http.createServer(handleRequest);

server.listen(PORT, function() {
    console.log('');
    console.log('=================================');
    console.log('  Bus Arrivals Server Running');
    console.log('=================================');
    console.log('');
    console.log('  Open in browser:');
    console.log('  http://localhost:' + PORT);
    console.log('');
    console.log('  On Kindle, use your computer\'s IP:');
    console.log('  http://YOUR_IP:' + PORT);
    console.log('');
    console.log('  Press Ctrl+C to stop');
    console.log('');
});
