const socket = io();

const state = {
  lobby: null,
  playerId: null,
  selectedTargetId: null,
  selectedVoteId: null,
  detectiveReport: null,
  timerIntervalId: null,
};

const elements = {
  setupScreen: document.getElementById('setup-screen'),
  lobbyScreen: document.getElementById('lobby-screen'),
  gameScreen: document.getElementById('game-screen'),
  playerName: document.getElementById('player-name'),
  createBtn: document.getElementById('create-btn'),
  joinCode: document.getElementById('join-code'),
  joinBtn: document.getElementById('join-btn'),
  lobbyCode: document.getElementById('lobby-code'),
  playerList: document.getElementById('player-list'),
  startBtn: document.getElementById('start-btn'),
  settingsPanel: document.getElementById('settings-panel'),
  nightLengthInput: document.getElementById('night-length'),
  dayLengthInput: document.getElementById('day-length'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  phaseTitle: document.getElementById('phase-title'),
  timerText: document.getElementById('timer-text'),
  roleCard: document.getElementById('role-card'),
  actionPanel: document.getElementById('action-panel'),
  resultPanel: document.getElementById('result-panel'),
};

function getRoleDescription(role) {
  switch (role) {
    case 'Mafia':
      return 'You are the Mafia. Each night you decide who to kill.';
    case 'Doctor':
      return 'You are the Doctor. Each night you may save one player.';
    case 'Detective':
      return 'You are the Detective. Each night you may learn if a player is good, bad, or neutral.';
    case 'Civilian':
      return 'You are a Civilian. You do nothing at night.';
    default:
      return 'Waiting for roles to be assigned.';
  }
}

function updateTimer() {
  if (!state.lobby || !state.lobby.phaseEndsAt) {
    elements.timerText.textContent = '';
    return;
  }
  const remaining = Math.max(0, Math.ceil((state.lobby.phaseEndsAt - Date.now()) / 1000));
  const label = state.lobby.phase === 'night'
    ? 'Night ends in'
    : state.lobby.phase === 'day'
      ? 'Day ends in'
      : state.lobby.phase === 'day-summary'
        ? 'Summary ends in'
        : 'Phase ends in';
  elements.timerText.textContent = `${label}: ${remaining}s`;
}

function render() {
  const lobby = state.lobby;
  if (!lobby) {
    elements.setupScreen.hidden = false;
    elements.lobbyScreen.hidden = true;
    elements.gameScreen.hidden = true;
    return;
  }

  if (lobby.phase === 'lobby') {
    elements.setupScreen.hidden = true;
    elements.lobbyScreen.hidden = false;
    elements.gameScreen.hidden = true;
    elements.lobbyCode.textContent = lobby.code;
    elements.playerList.innerHTML = lobby.players
      .map((player) => `<div class="player-pill">${player.name}${player.id === lobby.hostId ? ' 👑' : ''}</div>`)
      .join('');
    elements.startBtn.hidden = state.playerId !== lobby.hostId;
    elements.settingsPanel.hidden = state.playerId !== lobby.hostId;
    elements.nightLengthInput.value = lobby.nightDurationSeconds || 25;
    elements.dayLengthInput.value = lobby.dayDurationSeconds || 30;
    return;
  }

  elements.setupScreen.hidden = true;
  elements.lobbyScreen.hidden = true;
  elements.gameScreen.hidden = false;

  const myPlayer = lobby.players.find((player) => player.id === state.playerId);
  const phaseText = lobby.phase === 'role-reveal'
    ? 'Role Reveal'
    : lobby.phase === 'night'
      ? `Night ${lobby.nightNumber}`
      : lobby.phase === 'day'
        ? 'Daytime Discussion'
        : lobby.phase === 'day-summary'
          ? 'Vote Summary'
          : lobby.phase === 'ended'
            ? 'Game Over'
            : 'Game';
  elements.phaseTitle.textContent = phaseText;

  if (myPlayer) {
    elements.roleCard.innerHTML = myPlayer.role
      ? `<strong>You are the ${myPlayer.role}.</strong><br>${getRoleDescription(myPlayer.role)}`
      : 'Waiting for the host to assign roles.';
  } else {
    elements.roleCard.textContent = 'You are not in this lobby.';
  }

  updateTimer();

  if (lobby.phase === 'role-reveal' && myPlayer) {
    const readyCount = lobby.readyPlayers ? lobby.readyPlayers.length : 0;
    const totalPlayers = lobby.players.length;
    elements.actionPanel.innerHTML = `
      <div class="result-box">
        <strong>You are the ${myPlayer.role}.</strong>
        <p>${getRoleDescription(myPlayer.role)}</p>
        <p>${readyCount}/${totalPlayers} players ready.</p>
        <button id="ready-btn">Ready Up</button>
      </div>
    `;
    const readyButton = document.getElementById('ready-btn');
    if (readyButton) {
      readyButton.addEventListener('click', () => socket.emit('mark-ready'));
    }
  } else if (lobby.phase === 'night' && myPlayer?.isAlive) {
    if (myPlayer.role === 'Civilian') {
      elements.actionPanel.innerHTML = '<p>You are a civilian. You do nothing tonight.</p>';
    } else {
      const targets = lobby.players.filter((player) => player.isAlive && player.id !== state.playerId);
      const actionLabel = myPlayer.role === 'Mafia' ? 'kill' : myPlayer.role === 'Doctor' ? 'save' : 'investigate';
      if (targets.length === 0) {
        elements.actionPanel.innerHTML = '<p>No valid targets are available.</p>';
      } else {
        const selectedTarget = state.selectedTargetId;
        elements.actionPanel.innerHTML = `
          <p>Choose someone to ${actionLabel}.</p>
          ${targets.map((target) => `
            <button class="action-btn${selectedTarget === target.id ? ' selected' : ''}" data-target="${target.id}">${target.name}</button>
          `).join('')}
        `;
      }
    }
  } else if ((lobby.phase === 'day' || lobby.phase === 'day-summary') && myPlayer?.isAlive) {
    const alivePlayers = lobby.players.filter((player) => player.isAlive && player.id !== state.playerId);
    const voteCount = Object.keys(lobby.pendingVotes || {}).length;
    const skipVotes = Object.values(lobby.pendingVotes || {}).filter((value) => value === 'skip').length;
    const selectedVote = state.selectedVoteId;
    elements.actionPanel.innerHTML = `
      <p>Vote someone out, or skip the vote.</p>
      <button class="vote-btn skip-btn${selectedVote === 'skip' ? ' selected' : ''}" data-target="skip">Skip Vote</button>
      ${alivePlayers.map((player) => `<button class="vote-btn${selectedVote === player.id ? ' selected' : ''}" data-target="${player.id}">${player.name}</button>`).join('')}
      <p>${voteCount} / ${lobby.players.filter((entry) => entry.isAlive).length} players have voted.</p>
      <p>${skipVotes} skip votes so far.</p>
    `;
  } else if (!myPlayer?.isAlive) {
    elements.actionPanel.innerHTML = '<p>You are dead and cannot act.</p>';
  } else if (lobby.phase === 'ended') {
    elements.actionPanel.innerHTML = '<p>The game is over.</p>';
  } else {
    elements.actionPanel.innerHTML = '<p>Waiting for the next round.</p>';
  }

  if (lobby.lastResult) {
    const detectiveText = state.detectiveReport && myPlayer?.role === 'Detective'
      ? `Detective report: ${state.detectiveReport.targetName} was ${state.detectiveReport.alignment}.`
      : '';
    const killedText = lobby.lastResult.killed
      ? `${lobby.lastResult.killed.name} was killed.`
      : lobby.lastResult.isFirstNight
        ? 'The first night passed without any visible event.'
        : 'No one died this round.';
    const voteSummary = lobby.lastResult.voteSummary
      ? `<p><strong>Vote count:</strong></p>${lobby.lastResult.voteSummary.map((entry, index) => `<p>${index + 1}. ${entry.votes} - ${entry.name}</p>`).join('')}`
      : '';
    const votedOutText = lobby.lastResult.votedOut
      ? `${lobby.lastResult.votedOut.name} was voted out. They were ${lobby.lastResult.votedOutWasMafia ? 'a Mafia' : 'not a Mafia'}.`
      : '';
    const winText = lobby.phase === 'ended' && lobby.winner
      ? `<p class="${lobby.winner === 'mafia' ? 'win-text lose' : 'win-text win'}">${lobby.winner === 'mafia' ? 'MAFIA WINS' : 'TOWN WINS'}</p>`
      : '';
    const roleReveal = lobby.phase === 'ended'
      ? `<div class="role-reveal-list">${lobby.players.map((player) => `<p><strong>${player.role}:</strong> ${player.name}</p>`).join('')}</div>`
      : '';
    elements.resultPanel.innerHTML = `
      <div class="result-box">
        <strong>${lobby.lastResult.message}</strong>
        <p>${killedText}</p>
        ${voteSummary}
        ${votedOutText ? `<p>${votedOutText}</p>` : ''}
        ${winText}
        ${roleReveal}
        ${detectiveText ? `<p>${detectiveText}</p>` : ''}
      </div>
    `;
  } else {
    elements.resultPanel.innerHTML = '';
  }
}

function startTimer() {
  clearInterval(state.timerIntervalId);
  state.timerIntervalId = setInterval(updateTimer, 1000);
}

socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('lobby-created', ({ playerId, lobbyState }) => {
  state.playerId = playerId;
  state.lobby = lobbyState;
  state.selectedTargetId = null;
  render();
  startTimer();
});

socket.on('lobby-joined', ({ playerId, lobbyState }) => {
  state.playerId = playerId;
  state.lobby = lobbyState;
  state.selectedTargetId = null;
  render();
  startTimer();
});

socket.on('lobby-update', (lobbyState) => {
  if (state.lobby?.phase !== lobbyState.phase) {
    state.selectedTargetId = null;
    state.selectedVoteId = null;
  }
  state.lobby = lobbyState;
  render();
});

socket.on('lobby-error', ({ message }) => {
  alert(message);
});

socket.on('action-received', ({ message }) => {
  console.log(message);
});

socket.on('detective-report', (detectiveInfo) => {
  state.detectiveReport = detectiveInfo;
  render();
});

elements.createBtn.addEventListener('click', () => {
  socket.emit('create-lobby', { playerName: elements.playerName.value.trim() || 'Host' });
});

elements.joinBtn.addEventListener('click', () => {
  socket.emit('join-lobby', {
    lobbyCode: elements.joinCode.value.trim(),
    playerName: elements.playerName.value.trim() || 'Player',
  });
});

elements.startBtn.addEventListener('click', () => {
  socket.emit('start-game');
});

elements.saveSettingsBtn.addEventListener('click', () => {
  socket.emit('update-lobby-settings', {
    nightDurationSeconds: parseInt(elements.nightLengthInput.value, 10),
    dayDurationSeconds: parseInt(elements.dayLengthInput.value, 10),
  });
});

elements.actionPanel.addEventListener('click', (event) => {
  const button = event.target.closest('.action-btn');
  if (!button) return;
  const targetId = button.dataset.target;
  if (state.selectedTargetId === targetId) {
    state.selectedTargetId = null;
    socket.emit('submit-night-action', { targetId: null });
  } else {
    state.selectedTargetId = targetId;
    socket.emit('submit-night-action', { targetId });
  }
  render();
});

elements.actionPanel.addEventListener('click', (event) => {
  const button = event.target.closest('.vote-btn');
  if (!button) return;
  const targetId = button.dataset.target;
  if (state.selectedVoteId === targetId) {
    state.selectedVoteId = null;
    socket.emit('cast-vote', { targetId: null });
  } else {
    state.selectedVoteId = targetId;
    socket.emit('cast-vote', { targetId });
  }
  render();
});
