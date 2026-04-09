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
            penalizedTeams: [],
            requireRegistration: false // ★追加: 事前登録必須かどうかのフラグ（デフォルトOFF）
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
    
    // ★追加: ログイン画面を開いた時にルーム情報を取得する
    socket.on('check-room', (roomId) => {
        const r = rooms[roomId];
        if (r) {
            socket.emit('room-info', { 
                isTeamMode: r.isTeamMode, 
                teams: r.teams, 
                requireRegistration: r.requireRegistration 
            });
        } else {
            socket.emit('room-error', 'ルームが存在しません');
        }
    });

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
        socket.emit('registration-req-changed', r.requireRegistration); // ★追加
        socket.emit('admin-update-users', r.users);
        emitUpdate(roomId);
    });

    // ★追加: 事前登録ON/OFFの切り替え
    socket.on('admin-toggle-registration', (isRequired) => {
        const r = getRoom(socket.roomId);
        r.requireRegistration = isRequired;
        io.to(socket.roomId).emit('registration-req-changed', r.requireRegistration);
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

    socket.on('admin-delete-user', (username) => {
        const r = getRoom(socket.roomId);
        if (r.users[username]) {
            delete r.users[username];
            io.to(socket.roomId).emit('admin-update-users', r.users);
            io.to(socket.roomId).emit('user-deleted', username);
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
    socket.on('login', ({ roomId, username, team }) => {
        const r = getRoom(roomId);
        if (!r) return socket.emit('login-fail', 'ルームが存在しません');

        // ★変更: 事前登録OFFの場合は、ここで自動的にユーザー登録を行う
        if (!r.requireRegistration) {
            if (!r.users[username]) {
                r.users[username] = { team: r.isTeamMode ? team : '' };
                io.to(roomId).emit('admin-update-users', r.users);
            } else if (r.isTeamMode && team && r.users[username].team !== team) {
                // すでに同じ名前の人がいて、チームが違う場合は弾く（なりすまし防止）
                 return socket.emit('login-fail', 'その名前はすでに使用されています');
            }
        }

        if (r.users[username]) {
            socket.join(roomId);
            socket.roomId = roomId;
            const finalTeam = r.isTeamMode ? r.users[username].team : '';
            r.loggedInUsers[socket.id] = { name: username, team: finalTeam };
            socket.emit('login-success', { username, team: finalTeam, isTeamMode: r.isTeamMode });
            emitUpdate(roomId);
        } else {
            socket.emit('login-fail', '事前登録が必要です。管理者に確認してください。');
        }
    });

    socket.on('buzz', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const r = getRoom(roomId);
        const user = r.loggedInUsers[socket.id];
        
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

app.get('/health', (req, res) => {
    res.status(200).send('Server is alive!');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`サーバーが起動しました: ポート ${PORT}`);
});
