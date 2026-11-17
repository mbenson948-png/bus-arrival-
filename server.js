#!/usr/bin/env node
/**
 * Transport Departures Display - Server
 *
 * A simple proxy server for TfNSW API
 * Run: node server.js
 * Open: http://localhost:3000
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJQWFh6Q1I4OVd3bUlweTdldzZHbnRFcXV3azJXNW1NQXZ6d3BlX19aVkRVIiwiaWF0IjoxNzk0ODk4Mjg1fQ.V7JCyJnsy0AfhWytEZDVGDc_OEXavXHFScxX4E34WQM';

// Make HTTPS request to TfNSW API
function tfnswRequest(endpoint, callback) {
    const options = {
        hostname: 'api.transport.nsw.gov.au',
        port: 443,
        path: endpoint,
        method: 'GET',
        headers: {
            'Authorization': 'apikey ' + API_KEY,
            'Accept': 'application/json'
        }
    };

    console.log('API Request:', endpoint);

    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                callback(null, json);
            } catch (e) {
                callback('Invalid JSON response', null);
            }
        });
    });

    req.on('error', (e) => {
        console.error('API Error:', e.message);
        callback(e.message, null);
    });

    req.end();
}

// Search for stops/stations
function searchStops(query, callback) {
    const endpoint = '/v1/tp/stop_finder?' +
        'outputFormat=rapidJSON' +
        '&type_sf=any' +
        '&name_sf=' + encodeURIComponent(query) +
        '&coordOutputFormat=EPSG:4326' +
        '&TfNSWSF=true' +
        '&version=10.2.1.42' +
        '&anyMaxSizeHitList=50';

    tfnswRequest(endpoint, (err, data) => {
        if (err) return callback(err, null);

        // Get all locations and clean up names
        const stops = (data.locations || [])
            .filter(loc => {
                // Include stops and platforms
                return loc.type === 'stop' || loc.type === 'platform' ||
                       (loc.type === 'poi' && loc.productClasses && loc.productClasses.length > 0);
            })
            .map(loc => {
                // Use the cleanest name available
                let name = loc.disassembledName || loc.name || 'Unknown';
                let parent = loc.parent ? (loc.parent.disassembledName || loc.parent.name || '') : '';

                // Build mode info
                const modeNames = [];
                (loc.productClasses || []).forEach(m => {
                    if (m === 1) modeNames.push('Train');
                    else if (m === 2 || m === 4) modeNames.push('Metro/LR');
                    else if (m === 5) modeNames.push('Bus');
                    else if (m === 9) modeNames.push('Ferry');
                });

                return {
                    id: loc.id,
                    name: name,
                    parent: parent,
                    type: loc.type,
                    modes: loc.productClasses || [],
                    modeNames: [...new Set(modeNames)].join(', ')
                };
            });

        callback(null, stops);
    });
}

// Get departures for a stop
function getDepartures(stopId, callback) {
    const now = new Date();
    const date = now.getFullYear() +
        ('0' + (now.getMonth() + 1)).slice(-2) +
        ('0' + now.getDate()).slice(-2);
    const time = ('0' + now.getHours()).slice(-2) +
        ('0' + now.getMinutes()).slice(-2);

    const endpoint = '/v1/tp/departure_mon?' +
        'outputFormat=rapidJSON' +
        '&coordOutputFormat=EPSG:4326' +
        '&mode=direct' +
        '&type_dm=any' +
        '&name_dm=' + encodeURIComponent(stopId) +
        '&itdDate=' + date +
        '&itdTime=' + time +
        '&departureMonitorMacro=true' +
        '&TfNSWDM=true' +
        '&version=10.2.1.42';

    tfnswRequest(endpoint, (err, data) => {
        if (err) return callback(err, null);

        console.log('Departure response keys:', Object.keys(data));

        // Check for stopEvents
        if (!data.stopEvents || data.stopEvents.length === 0) {
            // Maybe try with the stop name from locations
            if (data.locations && data.locations.length > 0) {
                console.log('Got locations instead of departures, trying first location...');
                const firstStop = data.locations[0];
                if (firstStop.id && firstStop.id !== stopId) {
                    // Retry with the proper ID
                    return getDepartures(firstStop.id, callback);
                }
            }
            return callback(null, []);
        }

        // Parse departures
        const departures = data.stopEvents.map(event => {
            const transport = event.transportation || {};
            const route = transport.number || transport.disassembledName || '?';
            const destination = transport.destination ? transport.destination.name : '';
            const mode = transport.product ? transport.product.class : 0;

            // Get time
            let departureTime = event.departureTimeEstimated || event.departureTimePlanned;
            let minutes = 0;
            if (departureTime) {
                const depDate = new Date(departureTime);
                minutes = Math.round((depDate - now) / 60000);
            }

            // Mode names and keys for filtering
            const modeInfo = {
                1: { name: 'Train', key: 'train' },
                2: { name: 'Metro', key: 'metro' },
                4: { name: 'Light Rail', key: 'metro' },
                5: { name: 'Bus', key: 'bus' },
                7: { name: 'Coach', key: 'bus' },
                9: { name: 'Ferry', key: 'ferry' },
                11: { name: 'School Bus', key: 'schoolbus' }
            };

            const info = modeInfo[mode] || { name: 'Transport', key: 'bus' };

            return {
                route: route,
                destination: destination,
                minutes: minutes,
                mode: info.name,
                modeCode: mode,
                modeKey: info.key,
                occupancy: event.occupancy || 'UNKNOWN',
                platform: event.location ? event.location.platform : ''
            };
        });

        // Sort by time and filter out past departures
        const upcoming = departures
            .filter(d => d.minutes >= -1)
            .sort((a, b) => a.minutes - b.minutes);

        callback(null, upcoming);
    });
}

// HTTP request handler
function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    console.log(req.method, pathname);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');

    // API: Search stops
    if (pathname === '/api/stops') {
        const query = parsedUrl.query.q;
        if (!query) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Missing query parameter q'}));
            return;
        }

        searchStops(query, (err, stops) => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            if (err) {
                res.end(JSON.stringify({error: err}));
            } else {
                res.end(JSON.stringify({stops: stops}));
            }
        });
        return;
    }

    // API: Get departures
    if (pathname === '/api/departures') {
        const stopId = parsedUrl.query.stopId;
        if (!stopId) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Missing stopId parameter'}));
            return;
        }

        getDepartures(stopId, (err, departures) => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            if (err) {
                res.end(JSON.stringify({error: err}));
            } else {
                res.end(JSON.stringify({departures: departures}));
            }
        });
        return;
    }

    // Serve index.html
    if (pathname === '/' || pathname === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data);
        });
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
}

// Start server
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
    console.log('');
    console.log('================================');
    console.log('  Transport Display Server');
    console.log('================================');
    console.log('');
    console.log('  Open: http://localhost:' + PORT);
    console.log('');
    console.log('  For Kindle, use your IP:');
    console.log('  http://YOUR_IP:' + PORT);
    console.log('');
});
