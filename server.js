import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import WebTorrent from 'webtorrent';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import drive from './drive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

const client = new WebTorrent({ utp: false });

client.on('error', (err) => {
    console.error('WebTorrent client error:', err.message);
});


io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('start-transfer', async (magnetLink) => {
        console.log(`Received magnet link: ${magnetLink}`);
        socket.emit('log', 'Adding torrent...');

        client.add(magnetLink, { path: './downloads' }, (torrent) => {
            socket.emit('log', 'Torrent metadata received.');
            console.log('Torrent metadata received');

            // Find the largest file (likely the main content)
            const file = torrent.files.reduce((a, b) => a.length > b.length ? a : b);

            socket.emit('log', `Found file: ${file.name} (${(file.length / 1024 / 1024).toFixed(2)} MB)`);
            console.log(`File: ${file.name}`);

            const stream = file.createReadStream();

            socket.emit('log', 'Starting stream to Google Drive...');

            drive.uploadStream(file.name, stream, file.mime, file.length, (progressEvent) => {
                // Optional: Drive upload progress (might not be granular enough with streams)
                // console.log(progressEvent);
            }).then((fileId) => {
                socket.emit('log', `Upload Complete! File ID: ${fileId}`);
                socket.emit('success', `File uploaded successfully to Google Drive.`);
                // Cleanup torrent
                torrent.destroy();
            }).catch((err) => {
                console.error("Upload error:", err);
                socket.emit('error', `Upload failed: ${err.message}`);
                torrent.destroy();
            });

            // Monitor torrent download progress (which feeds the upload stream)
            // Since we are streaming, download speed allows upload to proceed.
            const interval = setInterval(() => {
                if (torrent.done) {
                    clearInterval(interval);
                    socket.emit('progress', 100);
                } else {
                    socket.emit('progress', (torrent.progress * 100).toFixed(1));
                    // socket.emit('log', `Download speed: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s`);
                }
            }, 1000);
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
    open(`http://localhost:${port}`);
});
