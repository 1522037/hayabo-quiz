const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function getRoom(id) {
    if (!rooms[id]) {
        rooms[id] = {
            adminKey: null,
            buzzList: [],
            isLocked: false,
            users: {},
            loggedInUsers: {},
            quizMode: 'queue',
            otetsukiMode: false,
            penaltyScope: 'individual',
            isTeamMode: false,
            teams: [],
            penalizedUsers: [],
            penalizedTeams: []
        };
    }
    return rooms[id];
}

function emitUpdate(roomId) {
    const r = rooms[roomId];
    io.to(roomId).emit('update', {
        buzzList: r.buzzList,
        isLocked: r.isLocked,
        penalizedUsers: r.penalizedUsers,
        penalizedTeams: r.penalizedTeams,
        isTeamMode: r.isTeamMode
    });
}

io.on('connection', (socket) => {
    
    socket.on('admin-join', ({ roomId, adminKey }) => {
        const r = getRoom(roomId);
        
        if (!r.adminKey) {
            r.adminKey = adminKey;
        } else if (r.adminKey !== adminKey) {
            socket.emit('admin-error', '管理者権限がありません。トップページに戻ります。');
            return;
        }

        socket.join(roomId);
        socket.roomId = roomId;
        
        socket.emit('mode-changed', r.quizMode);
        socket.emit('otetsuki-changed', r.otetsukiMode);
        socket.emit('penalty-scope-changed', r.penaltyScope);
        socket.emit('team-mode-changed', r.isTeamMode);
        socket.emit('teams-updated', r.teams);
        socket.emit('admin-update-users', r.users);
        emitUpdate(roomId);
    });

    socket.on('admin-register-user', ({ username, team }) => {
        const r = getRoom(socket.roomId);
        if (r.users[username]) {
            socket.emit('admin-message', 'そのユーザー名は既に存在します');
        } else {
            const finalTeam = r.isTeamMode ? team : '';
            r.users[username] = { team: finalTeam };
            io.to(socket.roomId).emit('admin-update-users', r.users);
            socket.emit('admin-message', `「${username}」を登録しました`);
        }
    });

    // ★追加: ユーザーの削除処理
    socket.on('admin-delete-user', (username) => {
        const r = getRoom(socket.roomId);
        if (r.users[username]) {
            delete r.users[username];
            io.to(socket.roomId).emit('admin-update-users', r.users);
            io.to(socket.roomId).emit('user-deleted', username); // 参加者側に通知して強制退室させる
            socket.emit('admin-message', `「${username}」を削除しました`);
        }
    });

    socket.on('admin-change-team-mode', (isTeam) => {
        const r = getRoom(socket.roomId);
        r.isTeamMode = isTeam;
        io.to(socket.roomId).emit('team-mode-changed', r.isTeamMode);
        emitUpdate(socket.roomId);
    });

    socket.on('admin-set-team-count', (count) => {
        const r = getRoom(socket.roomId);
        r.teams = [];
        const alphabets = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (let i = 0; i < count; i++) {
            r.teams.push(`TEAM ${alphabets[i] || i}`);
        }
        io.to(socket.roomId).emit('teams-updated', r.teams);
    });

    socket.on('admin-change-mode', (mode) => {
        const r = getRoom(socket.roomId);
        r.quizMode = mode;
        io.to(socket.roomId).emit('mode-changed', r.quizMode);
    });

    socket.on('admin-change-otetsuki', (isOtetsuki) => {
        const r = getRoom(socket.roomId);
        r.otetsukiMode = isOtetsuki;
        io.to(socket.roomId).emit('otetsuki-changed', r.otetsukiMode);
    });

    socket.on('admin-change-penalty-scope', (scope) => {
        const r = getRoom(socket.roomId);
        r.penaltyScope = scope;
        io.to(socket.roomId).emit('penalty-scope-changed', r.penaltyScope);
    });

    socket.on('admin-toggle-lock', (locked) => {
        const r = getRoom(socket.roomId);
        r.isLocked = locked;
        emitUpdate(socket.roomId);
    });

    socket.on('admin-play-thinking', () => {
        io.to(socket.roomId).emit('play-sound', 'thinking');
    });

    socket.on('admin-correct', () => {
        const r = getRoom(socket.roomId);
        if (r.buzzList.length > 0) {
            const winner = r.buzzList[0];
            io.to(socket.roomId).emit('play-sound', 'correct');
            io.to(socket.roomId).emit('celebrate', winner);
            r.isLocked = true;
            r.penalizedUsers = [];
            r.penalizedTeams = [];
            emitUpdate(socket.roomId);
        }
    });

    socket.on('wrong', () => {
        const r = getRoom(socket.roomId);
        io.to(socket.roomId).emit('play-sound', 'wrong');
        if (r.buzzList.length > 0) {
            const wrongUser = r.buzzList.shift();
            if (r.otetsukiMode) {
                if (r.isTeamMode && r.penaltyScope === 'team' && wrongUser.team) {
                    r.penalizedTeams.push(wrongUser.team);
                } else {
                    r.penalizedUsers.push(wrongUser.name);
                }
            }
            emitUpdate(socket.roomId);
        }
    });

    socket.on('reset', () => {
        const r = getRoom(socket.roomId);
        r.buzzList = [];
        r.isLocked = false;
        r.penalizedUsers = [];
        r.penalizedTeams = [];
        emitUpdate(socket.roomId);
    });

    // --- 参加者側の通信 ---
    socket.on('login', ({ roomId, username }) => {
        const r = getRoom(roomId);
        if (r && r.users[username]) {
            socket.join(roomId);
            socket.roomId = roomId;
            const team = r.isTeamMode ? r.users[username].team : '';
            r.loggedInUsers[socket.id] = { name: username, team: team };
            socket.emit('login-success', { username, team, isTeamMode: r.isTeamMode });
            emitUpdate(roomId);
        } else {
            socket.emit('login-fail', 'ユーザー名が登録されていません');
        }
    });

    socket.on('buzz', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const r = getRoom(roomId);
        const user = r.loggedInUsers[socket.id];
        
        // ★ユーザーが存在しない、または削除されている場合は弾く
        if (!user || !r.users[user.name]) return; 

        if (r.penalizedUsers.includes(user.name) || r.penalizedTeams.includes(user.team)) return;
        if (r.quizMode === 'single' && r.buzzList.length > 0) return;

        const alreadyBuzzed = r.buzzList.some(b => b.name === user.name);

        if (!r.isLocked && !alreadyBuzzed) {
            const now = Date.now();
            let timeDiff = 0;

            if (r.buzzList.length === 0) {
                io.to(roomId).emit('play-sound', 'buzz');
            } else {
                timeDiff = ((now - r.buzzList[0].time) / 1000).toFixed(2);
            }

            r.buzzList.push({ id: socket.id, name: user.name, team: user.team, time: now, timeDiff: timeDiff });
            r.penalizedUsers = [];
            r.penalizedTeams = [];
            emitUpdate(roomId);
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId] && rooms[socket.roomId].loggedInUsers) {
            delete rooms[socket.roomId].loggedInUsers[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`サーバーが起動しました: ポート ${PORT}`);
});