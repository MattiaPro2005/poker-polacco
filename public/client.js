const socket = io();
let myRoom = '';

function joinRoom() {
    const name = document.getElementById('playerName').value;
    myRoom = document.getElementById('roomCode').value;
    
    if (name && myRoom) {
        socket.emit('join_room', { name, room: myRoom });
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('game-screen').style.display = 'block';
        document.getElementById('room-display').innerText = myRoom;
    }
}

function startGame() {
    socket.emit('start_game', myRoom);
}

function makeBid() {
    const bid = document.getElementById('bidInput').value;
    if (bid) socket.emit('make_bid', { room: myRoom, bid });
}

function callBluff() {
    socket.emit('call_bluff', myRoom);
}

// Eventi dal Server
socket.on('update_players', (players) => {
    document.getElementById('players-list').innerHTML = players.map(p => `<p>${p.name} (${p.penalties} carte)</p>`).join('');
});

socket.on('deal_cards', (cards) => {
    document.getElementById('my-cards').innerHTML = cards.map(c => `<div class="card">${c}</div>`).join('');
});

socket.on('bid_updated', ({ bid, nextTurn }) => {
    document.getElementById('current-bid').innerText = `${bid} (Tocca a ${nextTurn})`;
});

socket.on('showdown', (players) => {
    let resultHTML = '<h3>SHOWDOWN!</h3>';
    players.forEach(p => {
        resultHTML += `<p><strong>${p.name}:</strong> ${p.cards.join(', ')}</p>`;
    });
    document.getElementById('my-cards').innerHTML = resultHTML;
});