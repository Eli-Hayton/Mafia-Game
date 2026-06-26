const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const lobbies = new Map();
const DEFAULT_NIGHT_DURATION_SECONDS = 25;
const DEFAULT_DAY_DURATION_SECONDS = 30;
const VOTE_SUMMARY_DURATION_MS = 10000;

function generateCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (lobbies.has(code));
  return code;
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getLobbyState(lobby) {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    hostName: lobby.hostName,
    players: lobby.players.map((player) => ({
      id: player.id,
      name: player.name,
      role: player.role,
      isAlive: player.isAlive,
    })),
    phase: lobby.phase,
    nightNumber: lobby.nightNumber,
    lastResult: lobby.lastResult,
    pendingActions: lobby.pendingActions,
    pendingVotes: lobby.pendingVotes,
    phaseEndsAt: lobby.phaseEndsAt,
    readyPlayers: lobby.readyPlayers || [],
    nightDurationSeconds: lobby.nightDurationSeconds,
    dayDurationSeconds: lobby.dayDurationSeconds,
    winner: lobby.winner,
    gameStarted: lobby.phase !== 'lobby',
  };
}

function broadcastLobby(lobby) {
  const state = getLobbyState(lobby);
  io.to(lobby.code).emit('lobby-update', state);
}

function getRoleDescription(role) {
  switch (role) {
    case 'Mafia':
      return 'Each night, the Mafia agrees on someone to kill.';
    case 'Doctor':
      return 'Each night, the Doctor can save one person from the Mafia.';
    case 'Detective':
      return 'Each night, the Detective learns whether a chosen player is good, bad, or neutral.';
    case 'Civilian':
      return 'The Civilian does not act at night.';
    default:
      return 'Waiting for the game to begin.';
  }
}

function determineWinner(lobby) {
  const alivePlayers = lobby.players.filter((player) => player.isAlive);
  const mafiaAlive = alivePlayers.filter((player) => player.role === 'Mafia');
  const civiliansAlive = alivePlayers.filter((player) => player.role !== 'Mafia');

  if (mafiaAlive.length === 0) {
    return 'civilians';
  }
  if (mafiaAlive.length >= civiliansAlive.length) {
    return 'mafia';
  }
  return null;
}

function startRoleReveal(lobby) {
  lobby.phase = 'role-reveal';
  lobby.pendingActions = {};
  lobby.pendingVotes = {};
  lobby.readyPlayers = [];
  lobby.phaseEndsAt = Date.now() + 5000;
  lobby.lastResult = {
    message: 'Role reveal',
    detectiveInfo: null,
    isFirstNight: true,
  };
  broadcastLobby(lobby);
}

function startNightPhase(lobby) {
  lobby.phase = 'night';
  lobby.pendingActions = {};
  lobby.pendingVotes = {};
  const nightDurationMs = (lobby.nightDurationSeconds || DEFAULT_NIGHT_DURATION_SECONDS) * 1000;
  lobby.phaseEndsAt = Date.now() + nightDurationMs;
  lobby.lastResult = {
    message: `Night ${lobby.nightNumber} has begun. Choose your action.`,
    detectiveInfo: null,
    isFirstNight: lobby.nightNumber === 1,
  };
  broadcastLobby(lobby);

  setTimeout(() => {
    resolveNight(lobby);
  }, nightDurationMs);
}

function resolveNight(lobby) {
  if (lobby.phase !== 'night') return;

  const requiredActions = ['Mafia', 'Doctor', 'Detective'].filter((role) =>
    lobby.players.some((entry) => entry.role === role && entry.isAlive)
  );

  const mafiaAction = lobby.pendingActions.Mafia?.targetId || null;
  const doctorAction = lobby.pendingActions.Doctor?.targetId || null;
  const detectiveAction = lobby.pendingActions.Detective?.targetId || null;

  const mafiaTarget = lobby.players.find((entry) => entry.id === mafiaAction);
  const doctorTarget = lobby.players.find((entry) => entry.id === doctorAction);
  const detectiveTarget = lobby.players.find((entry) => entry.id === detectiveAction);

  let killed = null;
  if (mafiaTarget && (!doctorTarget || doctorTarget.id !== mafiaTarget.id)) {
    killed = mafiaTarget;
  }

  if (killed) {
    const deadPlayer = lobby.players.find((entry) => entry.id === killed.id);
    if (deadPlayer) {
      deadPlayer.isAlive = false;
    }
  }

  let detectiveInfo = null;
  if (detectiveTarget) {
    detectiveInfo = {
      targetId: detectiveTarget.id,
      targetName: detectiveTarget.name,
      alignment: detectiveTarget.role === 'Mafia' ? 'bad' : detectiveTarget.role ? 'good' : 'neutral',
    };
  }

  const firstNight = lobby.nightNumber === 1;
  lobby.phase = 'day';
  lobby.phaseEndsAt = Date.now() + (lobby.dayDurationSeconds || DEFAULT_DAY_DURATION_SECONDS) * 1000;
  lobby.lastResult = {
    message: killed
      ? `${killed.name} was killed during the night.`
      : firstNight
        ? 'The first night passed. Daytime discussion begins.'
        : 'Morning report',
    killed: killed ? { id: killed.id, name: killed.name } : null,
    detectiveInfo,
    isFirstNight: firstNight,
  };
  lobby.pendingActions = {};
  lobby.pendingVotes = {};
  broadcastLobby(lobby);

  const detectivePlayer = lobby.players.find((entry) => entry.role === 'Detective' && entry.isAlive);
  if (detectivePlayer) {
    io.to(detectivePlayer.id).emit('detective-report', detectiveInfo);
  }

  setTimeout(() => {
    resolveDay(lobby);
  }, (lobby.dayDurationSeconds || DEFAULT_DAY_DURATION_SECONDS) * 1000);
}

function resolveDay(lobby) {
  if (lobby.phase !== 'day') return;

  const alivePlayers = lobby.players.filter((player) => player.isAlive);
  if (alivePlayers.length <= 1) {
    lobby.winner = determineWinner(lobby) || 'civilians';
    lobby.phase = 'ended';
    lobby.lastResult = {
      ...lobby.lastResult,
      message: lobby.winner === 'mafia' ? 'Mafia wins.' : 'Civilians win.',
    };
    broadcastLobby(lobby);
    return;
  }

  const voteEntries = Object.entries(lobby.pendingVotes || {});
  const skipVotes = voteEntries.filter(([, targetId]) => targetId === 'skip').length;
  const skipThreshold = Math.ceil(alivePlayers.length * (2 / 3));
  const counts = {};

  let targetId = null;
  if (skipVotes < skipThreshold) {
    voteEntries
      .filter(([, target]) => target !== 'skip')
      .forEach(([, target]) => {
        counts[target] = (counts[target] || 0) + 1;
      });

    let highestCount = 0;
    Object.entries(counts).forEach(([candidateId, count]) => {
      if (count > highestCount) {
        highestCount = count;
        targetId = candidateId;
      }
    });
  }

  const votedOut = targetId
    ? lobby.players.find((player) => player.id === targetId)
    : null;

  if (votedOut) {
    votedOut.isAlive = false;
  }

  const voteSummary = lobby.players
    .filter((player) => player.isAlive)
    .map((player) => ({
      id: player.id,
      name: player.name,
      votes: counts[player.id] || 0,
    }))
    .sort((a, b) => b.votes - a.votes);

  const winner = determineWinner(lobby);
  if (winner) {
    lobby.winner = winner;
    lobby.phase = 'ended';
    lobby.lastResult = {
      ...lobby.lastResult,
      message: winner === 'mafia' ? 'Mafia wins.' : 'Civilians win.',
      voteSummary,
      votedOut: votedOut ? { id: votedOut.id, name: votedOut.name, role: votedOut.role } : null,
      votedOutWasMafia: votedOut ? votedOut.role === 'Mafia' : false,
      voteSkipped: skipVotes >= skipThreshold,
    };
    broadcastLobby(lobby);
    return;
  }

  lobby.phase = 'day-summary';
  lobby.phaseEndsAt = Date.now() + VOTE_SUMMARY_DURATION_MS;
  lobby.lastResult = {
    message: votedOut ? `${votedOut.name} was voted out.` : 'No one was voted out.',
    killed: votedOut ? { id: votedOut.id, name: votedOut.name } : null,
    detectiveInfo: null,
    voteSummary,
    votedOut: votedOut ? { id: votedOut.id, name: votedOut.name, role: votedOut.role } : null,
    votedOutWasMafia: votedOut ? votedOut.role === 'Mafia' : false,
    voteSkipped: skipVotes >= skipThreshold,
  };
  broadcastLobby(lobby);

  setTimeout(() => {
    if (lobby.phase !== 'day-summary') return;
    lobby.nightNumber += 1;
    startNightPhase(lobby);
  }, VOTE_SUMMARY_DURATION_MS);
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('create-lobby', ({ playerName }) => {
    const code = generateCode();
    const lobby = {
      code,
      hostId: socket.id,
      hostName: playerName || 'Host',
      players: [{ id: socket.id, name: playerName || 'Host', role: null, isAlive: true }],
      phase: 'lobby',
      nightNumber: 0,
      lastResult: null,
      pendingActions: {},
      pendingVotes: {},
      phaseEndsAt: null,
      nightDurationSeconds: DEFAULT_NIGHT_DURATION_SECONDS,
      dayDurationSeconds: DEFAULT_DAY_DURATION_SECONDS,
      winner: null,
    };
    lobbies.set(code, lobby);
    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.playerId = socket.id;
    socket.emit('lobby-created', { code, playerId: socket.id, lobbyState: getLobbyState(lobby) });
    broadcastLobby(lobby);
  });

  socket.on('join-lobby', ({ lobbyCode, playerName }) => {
    const code = String(lobbyCode).trim().toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby) {
      socket.emit('lobby-error', { message: 'Lobby not found.' });
      return;
    }
    if (lobby.phase !== 'lobby') {
      socket.emit('lobby-error', { message: 'The game has already started.' });
      return;
    }

    const trimmedName = String(playerName || '').trim();
    const existing = lobby.players.find((player) => player.name.toLowerCase() === trimmedName.toLowerCase());
    if (trimmedName && existing) {
      socket.emit('lobby-error', { message: 'That name is already taken in this lobby.' });
      return;
    }

    const player = {
      id: socket.id,
      name: trimmedName || `Player ${lobby.players.length + 1}`,
      role: null,
      isAlive: true,
    };
    lobby.players.push(player);
    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.playerId = socket.id;
    socket.emit('lobby-joined', { code, playerId: socket.id, lobbyState: getLobbyState(lobby) });
    broadcastLobby(lobby);
  });

  socket.on('update-lobby-settings', ({ nightDurationSeconds, dayDurationSeconds }) => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby) return;
    if (lobby.hostId !== socket.id || lobby.phase !== 'lobby') return;

    const nightValue = parseInt(nightDurationSeconds, 10);
    const dayValue = parseInt(dayDurationSeconds, 10);
    if (Number.isFinite(nightValue) && nightValue > 0) {
      lobby.nightDurationSeconds = nightValue;
    }
    if (Number.isFinite(dayValue) && dayValue > 0) {
      lobby.dayDurationSeconds = dayValue;
    }

    broadcastLobby(lobby);
  });

  socket.on('start-game', () => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby) return;
    if (lobby.hostId !== socket.id) return;
    if (lobby.players.length < 4) {
      socket.emit('lobby-error', { message: 'At least 4 players are needed to start.' });
      return;
    }

    const rolePool = ['Mafia', 'Doctor', 'Detective'];
    const civilians = Math.max(lobby.players.length - rolePool.length, 0);
    const roles = [...rolePool, ...Array(civilians).fill('Civilian')];
    const shuffledRoles = shuffle(roles);

    lobby.players.forEach((player, index) => {
      player.role = shuffledRoles[index] || 'Civilian';
      player.isAlive = true;
    });

    lobby.readyPlayers = [];
    lobby.winner = null;
    lobby.nightNumber = 1;
    lobby.lastResult = { message: 'Night has begun. Choose your action.' };
    startRoleReveal(lobby);
  });

  socket.on('mark-ready', () => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby || lobby.phase !== 'role-reveal') return;

    const player = lobby.players.find((entry) => entry.id === socket.id);
    if (!player) return;

    if (!lobby.readyPlayers.includes(socket.id)) {
      lobby.readyPlayers.push(socket.id);
    }

    if (lobby.readyPlayers.length === lobby.players.length) {
      startNightPhase(lobby);
    } else {
      broadcastLobby(lobby);
    }
  });

  socket.on('submit-night-action', ({ targetId }) => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby || lobby.phase !== 'night') return;

    const player = lobby.players.find((entry) => entry.id === socket.id);
    if (!player || !player.isAlive) return;
    if (!player.role || player.role === 'Civilian') return;

    if (targetId) {
      const target = lobby.players.find((entry) => entry.id === targetId);
      if (!target || !target.isAlive || target.id === player.id) return;
      lobby.pendingActions[player.role] = { playerId: socket.id, targetId: target.id };
    } else {
      delete lobby.pendingActions[player.role];
    }
    socket.emit('action-received', { message: 'Your action was submitted.' });

    const requiredActions = ['Mafia', 'Doctor', 'Detective'].filter((role) =>
      lobby.players.some((entry) => entry.role === role && entry.isAlive)
    );
    const submitted = requiredActions.filter((role) => lobby.pendingActions[role]);

    if (submitted.length === requiredActions.length) {
      resolveNight(lobby);
    } else {
      broadcastLobby(lobby);
    }
  });

  socket.on('cast-vote', ({ targetId }) => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby || lobby.phase !== 'day') return;

    const player = lobby.players.find((entry) => entry.id === socket.id);
    if (!player || !player.isAlive) return;

    if (targetId) {
      lobby.pendingVotes[socket.id] = targetId === 'skip' ? 'skip' : targetId;
    } else {
      delete lobby.pendingVotes[socket.id];
    }

    const alivePlayers = lobby.players.filter((entry) => entry.isAlive);
    const voteCount = Object.keys(lobby.pendingVotes).length;
    const skipVotes = Object.values(lobby.pendingVotes).filter((value) => value === 'skip').length;
    const skipThreshold = Math.ceil(alivePlayers.length * (2 / 3));

    if (voteCount === alivePlayers.length || skipVotes >= skipThreshold) {
      resolveDay(lobby);
    } else {
      broadcastLobby(lobby);
    }
  });

  socket.on('disconnect', () => {
    const lobbyCode = socket.data.lobbyCode;
    if (!lobbyCode) return;

    const lobby = lobbies.get(lobbyCode);
    if (!lobby) return;

    lobby.players = lobby.players.filter((player) => player.id !== socket.id);
    if (lobby.players.length === 0) {
      lobbies.delete(lobbyCode);
      return;
    }

    if (lobby.hostId === socket.id) {
      lobby.hostId = lobby.players[0].id;
      lobby.hostName = lobby.players[0].name;
    }

    broadcastLobby(lobby);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
