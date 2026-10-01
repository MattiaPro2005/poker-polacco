const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Permette al server di leggere file JSON (usato dal pannello admin)
app.use(express.json());
app.use(express.static('public'));

const rooms = {};
const suits = ['♠', '♥', '♦', '♣'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    let deck = [];
    for (let s of suits) for (let v of values) deck.push(v + s);
    return deck.sort(() => Math.random() - 0.5);
}

function checkBid(allCards, bid) {
    const counts = {};
    const suitCounts = { '♠':0, '♥':0, '♦':0, '♣':0 };
    
    allCards.forEach(c => {
        let v = c.slice(0, -1);
        let s = c.slice(-1);
        counts[v] = (counts[v] || 0) + 1;
        suitCounts[s]++;
    });

    switch(bid.type) {
        case 'Carta Alta': return counts[bid.val1] >= 1;
        case 'Coppia': return counts[bid.val1] >= 2;
        case 'Doppia Coppia': return counts[bid.val1] >= 2 && counts[bid.val2] >= 2;
        case 'Tris': return counts[bid.val1] >= 3;
        case 'Full': return counts[bid.val1] >= 3 && counts[bid.val2] >= 2;
        case 'Poker': return counts[bid.val1] >= 4;
        case 'Colore': return suitCounts[bid.suit] >= 5;
        default: return false; 
    }
}

// --- ROTTE PANNELLO ADMIN ---

app.get('/api/admin/rooms', (req, res) => {
    const roomsData = {};
    for (let r in rooms) {
        roomsData[r] = rooms[r].players.map(p => ({ id: p.id, name: p.name, penalties: p.penalties, isEliminated: p.isEliminated }));
    }
    res.json(roomsData);
});

app.post('/api/admin/kick', (req, res) => {
    const { room, playerId } = req.body;
    if (rooms[room]) {
        // Avvisa il giocatore specifico che è stato cacciato
        io.to(playerId).emit('kicked', 'Sei stato rimosso dalla stanza dall\'amministratore.');
        
        // Rimuove il giocatore dalla memoria
        rooms[room].players = rooms[room].players.filter(p => p.id !== playerId);
        
        // Disconnette la socket
        const socketToKick = io.sockets.sockets.get(playerId);
        if(socketToKick) socketToKick.leave(room);

        // Aggiorna gli altri giocatori
        io.to(room).emit('update_players', rooms[room].players);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Stanza non trovata' });
    }
});

app.post('/api/admin/delete_room', (req, res) => {
    const { room } = req.body;
    if (rooms[room]) {
        io.to(room).emit('kicked', 'La stanza è stata chiusa dall\'amministratore.');
        
        rooms[room].players.forEach(p => {
            const s = io.sockets.sockets.get(p.id);
            if(s) s.leave(room);
        });
        
        delete rooms[room]; 
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Stanza non trovata' });
    }
});

// --- LOGICA DI GIOCO ---

io.on('connection', (socket) => {
    socket.on('join_room', ({ name, room }) => {
        socket.join(room);
        if (!rooms[room]) rooms[room] = { players: [], deck: [], currentBid: null, turnIndex: 0, lastBidder: null };
        
        rooms[room].players.push({ id: socket.id, name, cards: [], penalties: 1, isEliminated: false });
        io.to(room).emit('update_players', rooms[room].players);
    });

    socket.on('start_game', (room) => {
        let game = rooms[room];
        if(!game) return;

        let activePlayers = game.players.filter(p => !p.isEliminated);
        if (activePlayers.length <= 1) {
            game.players.forEach(p => { p.penalties = 1; p.isEliminated = false; });
            game.turnIndex = 0;
            io.to(room).emit('update_players', game.players);
        }

        game.deck = createDeck();
        game.currentBid = null;
        game.lastBidder = null;
        
        game.players.forEach(p => {
            if (p.isEliminated) { p.cards = []; } 
            else { p.cards = game.deck.splice(0, p.penalties); }
            io.to(p.id).emit('deal_cards', p.cards);
        });
        
        while(game.players[game.turnIndex] && game.players[game.turnIndex].isEliminated) {
            game.turnIndex = (game.turnIndex + 1) % game.players.length;
        }

        io.to(room).emit('game_started', { turn: game.players[game.turnIndex].name });
    });

    socket.on('make_bid', ({ room, bid }) => {
        let game = rooms[room];
        if (!game || game.players[game.turnIndex].id !== socket.id) return;
        
        game.currentBid = bid;
        game.lastBidder = game.players[game.turnIndex];
        
        do {
            game.turnIndex = (game.turnIndex + 1) % game.players.length;
        } while (game.players[game.turnIndex].isEliminated);

        io.to(room).emit('bid_updated', { bid: bid.text, nextTurn: game.players[game.turnIndex].name });
    });

    socket.on('call_bluff', (room) => {
        let game = rooms[room];
        if (!game || game.players[game.turnIndex].id !== socket.id || !game.currentBid) return;

        let doubter = game.players[game.turnIndex];
        let bidder = game.lastBidder;

        let allCards = [];
        game.players.forEach(p => allCards = allCards.concat(p.cards));

        let bidExists = checkBid(allCards, game.currentBid);
        
        let loser, winner;
        if (bidExists) { loser = doubter; winner = bidder; } 
        else { loser = bidder; winner = doubter; }

        loser.penalties += 1;
        let eliminatedName = null;

        // Limite di 7 carte
        if (loser.penalties >= 7) {
            loser.isEliminated = true;
            eliminatedName = loser.name;
        }

        let remainingPlayers = game.players.filter(p => !p.isEliminated);
        let gameOver = false;
        let gameWinner = null;

        if (remainingPlayers.length === 1) {
            gameOver = true;
            gameWinner = remainingPlayers[0].name;
        }

        if (!gameOver) {
            game.turnIndex = game.players.findIndex(p => p.id === winner.id);
            while(game.players[game.turnIndex].isEliminated) {
                game.turnIndex = (game.turnIndex + 1) % game.players.length;
            }
        }

        io.to(room).emit('update_players', game.players);

        io.to(room).emit('showdown', {
            players: game.players.filter(p => p.cards.length > 0),
            bidExists,
            loser: loser.name,
            winner: winner.name,
            bidText: game.currentBid.text,
            eliminatedName,
            gameOver,
            gameWinner
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server in esecuzione sulla porta ${PORT}`));