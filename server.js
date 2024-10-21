const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

// Create a WebSocket server that listens on port 8080
const wss = new WebSocket.Server({ port: 8080 });

let pingInterval = 20000;
let lobbies = {}; // e.g., { 'lobby1': [wsc1, wsc2], 'lobby2': [wsc3, wsc4] }

let errorResponse = 'errorResponse';

let connectedResponse = 'connectedResponse';

let fetchLobbyRequest = 'fetchLobbyRequest';
let fetchLobbyResponse = 'fetchLobbyResponse';

let createLobbyRequest = 'createLobbyRequest';
let createLobbyResponse = 'createLobbyResponse';

let joinLobbyRequest = 'joinLobbyRequest';
let joinLobbyClientResponse = 'joinLobbyClientResponse';
let joinLobbyBroadcastResponse = 'joinLobbyBroadcastResponse';

let leaveLobbyRequest = 'leaveLobbyRequest';
let leaveLobbyClientResponse = 'leaveLobbyClientResponse';
let leaveLobbyBroadcastResponse = 'leaveLobbyBroadcastResponse';

let clearCacheEventRequest = 'clearCacheEventRequest';
let cacheEventRequest = 'cacheEventRequest';
let eventRequest = 'clientEventRequest';
let eventResponse = 'clientEventResponse';


function fetchLobbies(wsc) {
    let lobbyData = Object.keys(lobbies).map(lobbyName => ({
        name: lobbyName,
        playerCount: lobbies[lobbyName].clients.length,
        capacity: lobbies[lobbyName].capacity,
        requiresPassword: lobbies[lobbyName].password !== null
    }));

    sendMessage(wsc, fetchLobbyResponse, 'LOBBIES_FETCHED', JSON.stringify(lobbyData));
}

function createLobby(wsc, lobbyName, capacity = 10, password = null) {
    if (lobbies[lobbyName]) {
        sendMessage(wsc, errorResponse, 'LobbyAlreadyExists', 'The lobby "${lobbyName}" already exists.');
        return false;
    } else {
        const hashedPassword = password ? bcrypt.hashSync(password, 10) : null;
        lobbies[lobbyName] = { clients: [], password: hashedPassword, capacity: capacity, eventBuffer: []};
        lobbies[lobbyName].clients.push(wsc);
        wsc.lobby = lobbyName;
        sendMessage(wsc, createLobbyResponse, 'LOBBY_CREATED', 'Lobby "${lobbyName}" created successfully.');
        return true;
    }
}

function joinLobby(wsc, lobbyName, password = null) {
    if (wsc.lobby) {
        sendMessage(wsc, errorResponse, 'AlreadyInLobby', 'You are already inside a lobby. Please leave your current lobby before joining a new one.');
        return false;
    }

    if (!lobbies[lobbyName]) {
        sendMessage(wsc, errorResponse, 'LobbyNotFound', 'The lobby "${lobbyName}" does not exist.');
        return false;
    }

    if (lobbies[lobbyName].clients.length >= lobbies[lobbyName].capacity) {
        sendMessage(wsc, errorResponse, 'LobbyFull', `The lobby "${lobbyName}" is full.`);
        return false;
    }

    if (lobbies[lobbyName].password && !bcrypt.compareSync(password, lobbies[lobbyName].password)) {
        sendMessage(wsc, errorResponse, 'InvalidPassword', 'The password you entered is incorrect.');
        return false;
    }

    lobbies[lobbyName].clients.push(wsc);
    wsc.lobby = lobbyName;

    let clientIds = lobbies[lobbyName].clients.map(client => client.id);
    sendMessage(wsc, joinLobbyClientResponse, 'LOBBY_JOINED', JSON.stringify({clientIds : clientIds, lobbyData : lobbies[lobbyName].eventBuffer}));
    return true;
}

function broadcastJoinLobby(wsc, msgObj) {
    if (joinLobby(wsc, msgObj.lobby, msgObj.password)) {
        broadcastToLobby(msgObj.lobby, joinLobbyBroadcastResponse, 'USER_JOINED', JSON.stringify({clientId : wsc.id}), wsc);
    }
}

function leaveLobby(wsc, lobbyName) {
    if (!lobbyName) {
        sendMessage(wsc, errorResponse, 'NotInLobby', 'You are not currently in a lobby.');
        return false;
    }

    if (lobbies[lobbyName]) {
        lobbies[lobbyName].clients = lobbies[lobbyName].clients.filter(client => client !== wsc);
        wsc.lobby = null;
        if (lobbies[lobbyName].clients.length === 0) {
            delete lobbies[lobbyName];
        }
        sendMessage(wsc, leaveLobbyClientResponse, 'LOBBY_LEFT', 'You have left the lobby "${lobbyName}".');
        return true;
    }
}

function broadcastLeaveLobby(wsc) {
    let userID = wsc.id;
    let lobby = wsc.lobby;
    if (leaveLobby(wsc, lobby) && lobbies[lobby]) {
        broadcastToLobby(lobby, leaveLobbyBroadcastResponse, 'USER_LEFT', JSON.stringify({clientId : userID}));
    }
}

function broadcastToLobby(lobbyName, type, reason, data, excludedClient = null) {
    lobbies[lobbyName].clients.forEach(client => {
        if (excludedClient && excludedClient === client) return;

        if (client.readyState === WebSocket.OPEN) {
            sendMessage(client, type, reason, data);
        }
    });
}

function sendMessage(wsc, type, reason, message) {
    if (wsc.readyState === WebSocket.OPEN) {
        wsc.send(JSON.stringify({
            type: type,
            reason: reason,
            message: message
        }));
    }
}

// Event listener for new client connections
wss.on('connection', (wsc) => {
    console.log('New client connected');
    wsc.id = uuidv4();

    // Error handling for individual client connection
    wsc.on(errorResponse, (error) => {
        console.error('WebSocket error on client connection:', error);
    });

    sendMessage(wsc, connectedResponse, 'USER_CONNECTED', JSON.stringify({clientId : wsc.id}));

    // Set up an interval to send pings every 30 seconds
    setInterval(() => {
        wss.clients.forEach(client => {
            if (client.isAlive === false) return client.terminate();
            client.isAlive = false;
            client.ping();
        });
    }, pingInterval);

    wsc.on('pong', () => {
        wsc.isAlive = true;
    });

    // Event listener for messages received from clients
    wsc.on('message', (message) => {
        try {
            let msgObj = JSON.parse(message);
            switch (msgObj.type) {
                case fetchLobbyRequest:
                    fetchLobbies(wsc);
                    break;
                case createLobbyRequest:
                    createLobby(wsc, msgObj.lobby, msgObj.capacity, msgObj.password);
                    break;
                case joinLobbyRequest:
                    broadcastJoinLobby(wsc, msgObj);
                    break;
                case leaveLobbyRequest:
                    broadcastLeaveLobby(wsc);
                    break;
                case cacheEventRequest:
                    if (wsc.lobby) {
                        let json = JSON.stringify(msgObj.data);
                        lobbies[wsc.lobby].eventBuffer.push(json);
                        broadcastToLobby(wsc.lobby, eventResponse, 'BROADCAST', json);
                    } else {
                        sendMessage(wsc, errorResponse, 'NoLobbyJoined', 'You have not joined any lobby!');
                    }
                    break;
                case eventRequest:
                if (wsc.lobby) {
                    broadcastToLobby(wsc.lobby, eventResponse, 'BROADCAST', JSON.stringify(msgObj.data));
                } else {
                    sendMessage(wsc, errorResponse, 'NoLobbyJoined', 'You have not joined any lobby!');
                }
                    break;
                case clearCacheEventRequest:
                    console.log("cleared cache");
                    lobbies[wsc.lobby].eventBuffer = [];
                    break;
                // Handle more message types as needed
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    // Event listener for client disconnection
    wsc.on('close', (code, reason) => {
        console.log(`Client disconnected with code: ${code}, reason: ${reason}`);
        broadcastLeaveLobby(wsc);
    });
});

// Global error handler for the WebSocket server
wss.on(errorResponse, (error) => {
    console.error('WebSocket server error:', error);
});

console.log('WebSocket server is running on ws://localhost:8080');
