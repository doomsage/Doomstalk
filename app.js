import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  arrayRemove
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const FIREBASE_CONFIG = window.DOOMSTALK_FIREBASE_CONFIG || {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME'
};

const configured = FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== 'REPLACE_ME';
let firebase = null;
if (configured) {
  const app = initializeApp(FIREBASE_CONFIG);
  firebase = { app, auth: getAuth(app), db: getFirestore(app) };
}

const initialState = { users: [], directChats: [], groups: [], notifications: [], messages: [], typing: [] };
let state = structuredClone(initialState);
let activeChatRef = null;
let activeUnsubMessages = null;
let typingUnsub = null;
let unsubscribeFns = [];
let typingDebounce = null;

const uiState = {
  section: 'chats',
  listSearch: '',
  searchQuery: '',
  searchTab: 'users',
  showGroupPanel: false,
  profileDraft: '',
  showNotificationsDropdown: false
};

const sections = ['chats', 'groups', 'search', 'profile', 'notifications', 'settings'];
const currentUser = () => firebase?.auth?.currentUser || null;
const userById = (id) => state.users.find((u) => u.id === id);
const nowMs = () => Date.now();
const typingDocId = (chatRef, userId) => `${chatRef.replace(':', '_')}_${userId}`;

const format = (ts) => {
  if (!ts) return '—';
  if (typeof ts === 'string') return new Date(ts).toLocaleString();
  if (ts?.toDate) return ts.toDate().toLocaleString();
  return new Date(ts).toLocaleString();
};

const initials = (name = 'U') => name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();

function chatMessages(chatRef) {
  return state.messages
    .filter((m) => m.chatRef === chatRef)
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
}

function latestMessage(chatRef) {
  return chatMessages(chatRef).slice(-1)[0] || null;
}

function unreadCount(chatRef, meId) {
  return state.messages.filter((m) => m.chatRef === chatRef && m.senderId !== meId && !m.deleted && !(m.seenBy || []).includes(meId)).length;
}

function displayNameById(id) {
  const u = userById(id);
  return u?.username || u?.email || 'Unknown';
}

function participantsLabel(chat, meId) {
  if (chat.type === 'group') return chat.name;
  const other = userById((chat.members || []).find((x) => x !== meId));
  return other?.username || other?.email || 'Unknown user';
}

function chatPresenceLabel(chat, meId) {
  if (chat.type === 'group') return `${(chat.members || []).length} members`;
  const other = userById((chat.members || []).find((x) => x !== meId));
  if (!other) return 'offline';
  return other.online ? 'online' : `last seen ${format(other.lastSeen)}`;
}

function messageStatus(m, chat, meId) {
  if (m.senderId !== meId) return '';
  if (chat.type === 'group') {
    const totalOthers = (chat.members || []).length - 1;
    const seenByOthers = (m.seenBy || []).filter((id) => id !== meId).length;
    return seenByOthers >= totalOthers ? 'seen' : 'delivered';
  }
  const otherId = (chat.members || []).find((id) => id !== meId);
  return (m.seenBy || []).includes(otherId) ? 'seen' : 'delivered';
}

async function ensureProfile(user, fallbackName = null) {
  const ref = doc(firebase.db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      username: fallbackName || user.displayName || user.email?.split('@')[0] || 'user',
      email: user.email || '',
      about: 'Hey there! I am using Doomstalk.',
      online: true,
      lastSeen: serverTimestamp(),
      createdAt: serverTimestamp()
    });
  } else {
    await updateDoc(ref, { online: true, lastSeen: serverTimestamp() });
  }
}

function detachListeners() {
  unsubscribeFns.forEach((fn) => fn && fn());
  unsubscribeFns = [];
  if (activeUnsubMessages) activeUnsubMessages();
  if (typingUnsub) typingUnsub();
  activeUnsubMessages = null;
  typingUnsub = null;
}

function attachCoreListeners() {
  const me = currentUser();
  if (!me) return;

  unsubscribeFns = [
    onSnapshot(collection(firebase.db, 'users'), (snap) => {
      state.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
    onSnapshot(query(collection(firebase.db, 'directChats'), where('members', 'array-contains', me.uid)), (snap) => {
      state.directChats = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
    onSnapshot(query(collection(firebase.db, 'groups'), where('members', 'array-contains', me.uid)), (snap) => {
      state.groups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
    onSnapshot(
      query(collection(firebase.db, 'notifications'), where('userId', '==', me.uid), orderBy('createdAt', 'desc'), limit(50)),
      (snap) => {
        state.notifications = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
      }
    )
  ];
}

function attachMessageListener(chatRef) {
  if (activeUnsubMessages) activeUnsubMessages();
  activeUnsubMessages = onSnapshot(query(collection(firebase.db, 'messages'), where('chatRef', '==', chatRef), orderBy('createdAt', 'asc')), (snap) => {
    state.messages = [...state.messages.filter((m) => m.chatRef !== chatRef), ...snap.docs.map((d) => ({ id: d.id, ...d.data() }))];
    markSeenInActiveChat();
    render(false);
  });
}

function attachTypingListener(chatRef) {
  if (typingUnsub) typingUnsub();
  typingUnsub = onSnapshot(query(collection(firebase.db, 'typingStatus'), where('chatRef', '==', chatRef)), (snap) => {
    state.typing = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => t.isTyping && nowMs() - (t.updatedAtMs || 0) < 5000);
    render(false);
  });
}

async function setTyping(chatRef, isTyping) {
  const me = currentUser();
  if (!me || !chatRef) return;
  const ref = doc(firebase.db, 'typingStatus', typingDocId(chatRef, me.uid));
  await setDoc(ref, {
    chatRef,
    userId: me.uid,
    username: displayNameById(me.uid),
    isTyping,
    updatedAtMs: nowMs(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function refreshChatMessages(chatRef) {
  const snap = await getDocs(query(collection(firebase.db, 'messages'), where('chatRef', '==', chatRef), orderBy('createdAt', 'asc')));
  state.messages = [...state.messages.filter((m) => m.chatRef !== chatRef), ...snap.docs.map((d) => ({ id: d.id, ...d.data() }))];
  render(false);
}

async function markSeenInActiveChat() {
  const me = currentUser();
  if (!me || !activeChatRef) return;
  const targets = chatMessages(activeChatRef).filter((m) => m.senderId !== me.uid && !m.deleted && !(m.seenBy || []).includes(me.uid));
  for (const msg of targets) {
    await updateDoc(doc(firebase.db, 'messages', msg.id), { seenBy: arrayUnion(me.uid) });
  }
}

function getAllChats(meId) {
  return [
    ...state.directChats.map((c) => ({ ...c, type: 'direct', chatRef: `direct:${c.id}` })),
    ...state.groups.map((g) => ({ ...g, type: 'group', chatRef: `group:${g.id}` }))
  ]
    .filter((c) => (c.members || []).includes(meId))
    .sort((a, b) => (latestMessage(b.chatRef)?.createdAt?.seconds || 0) - (latestMessage(a.chatRef)?.createdAt?.seconds || 0));
}

function render(checkListeners = true) {
  const root = document.getElementById('app');

  const focused = document.activeElement?.id ? {
    id: document.activeElement.id,
    start: document.activeElement.selectionStart,
    end: document.activeElement.selectionEnd
  } : null;

  if (!configured) {
    root.innerHTML = `<div class="auth-wrap"><div class="auth card"><h2>Firebase config missing</h2><p class="small">Set values in firebase-config.js</p></div></div>`;
    return;
  }

  const me = currentUser();
  if (!me) {
    root.innerHTML = authHTML();
    bindAuth();
    return;
  }

  const myProfile = userById(me.uid);
  if (!uiState.profileDraft) uiState.profileDraft = myProfile?.username || '';

  const chats = getAllChats(me.uid);
  if (!activeChatRef && chats.length) activeChatRef = chats[0].chatRef;
  const activeChat = chats.find((c) => c.chatRef === activeChatRef) || null;

  if (activeChat && checkListeners) {
    attachMessageListener(activeChat.chatRef);
    attachTypingListener(activeChat.chatRef);
  }

  const middleItems = (uiState.section === 'groups' ? chats.filter((c) => c.type === 'group') : chats.filter((c) => c.type === 'direct'))
    .filter((c) => participantsLabel(c, me.uid).toLowerCase().includes(uiState.listSearch.toLowerCase()) || (c.name || '').toLowerCase().includes(uiState.listSearch.toLowerCase()));

  root.innerHTML = `
  <div class="layout3">
    <aside class="left-sticky card">
      <div class="logo row"><div class="avatar big">D</div><div><strong>Doomstalk</strong><div class="small">Realtime social chat</div></div></div>
      <div class="left-tabs">
        ${sections.map((s) => `<button class="tab-btn ${uiState.section === s ? 'active' : ''}" data-section="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
      </div>
      <div class="left-footer small">@${myProfile?.username || 'user'} • ${me.email || ''}</div>
    </aside>

    <section class="middle card">
      ${(uiState.section === 'chats' || uiState.section === 'groups') ? `
        <div class="middle-head">
          <input id="listSearch" placeholder="Search ${uiState.section}" value="${escapeHtml(uiState.listSearch)}" />
        </div>
        <div class="scroll-list">
          ${middleItems.map((c) => {
            const lm = latestMessage(c.chatRef);
            const label = participantsLabel(c, me.uid);
            return `<div class="list-item ${activeChat?.chatRef === c.chatRef ? 'active' : ''}">
              <button class="item-main" data-chat="${c.chatRef}">
                <div class="row space"><div class="row"><div class="avatar">${initials(label)}</div><div><div class="name">${label}</div><div class="preview">${lm?.deleted ? 'message deleted' : (lm?.type === 'text' ? escapeHtml((lm?.content || '').slice(0, 50)) : (lm ? `[${lm.type}]` : 'No messages yet'))}</div></div></div><div class="time">${lm ? format(lm.createdAt) : ''}</div></div>
                <div class="row space"><span class="small">${chatPresenceLabel(c, me.uid)}</span><span class="badge">${unreadCount(c.chatRef, me.uid)}</span></div>
              </button>
              <button class="refresh" data-refresh-chat="${c.chatRef}">⟳</button>
            </div>`;
          }).join('') || '<div class="small">No items</div>'}
        </div>` : ''}

      ${uiState.section === 'search' ? searchPanel(me.uid) : ''}
      ${uiState.section === 'profile' ? profilePanel(myProfile, me.uid) : ''}
      ${uiState.section === 'notifications' ? notificationsPanel() : ''}
      ${uiState.section === 'settings' ? settingsPanel() : ''}
    </section>

    <section class="right card">
      ${(uiState.section === 'chats' || uiState.section === 'groups') ? chatWindow(activeChat, me.uid) : `<div class="placeholder">Open <b>${uiState.section}</b> from middle panel. Chat window stays here.</div>`}
    </section>
  </div>`;

  bindMain(activeChat, me.uid);

  if (focused?.id) {
    const el = document.getElementById(focused.id);
    if (el) {
      el.focus();
      if (typeof focused.start === 'number' && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(focused.start, focused.end || focused.start);
      }
    }
  }
}

function searchPanel(meId) {
  const users = state.users
    .filter((u) => u.id !== meId)
    .filter((u) => (u.username || '').toLowerCase().includes(uiState.searchQuery.toLowerCase()) || (u.email || '').toLowerCase().includes(uiState.searchQuery.toLowerCase()));
  const groups = state.groups.filter((g) => (g.name || '').toLowerCase().includes(uiState.searchQuery.toLowerCase()));

  return `<div class="panel-wrap">
    <div class="row space"><h3>Search</h3><div class="segmented"><button id="searchUsersTab" class="${uiState.searchTab === 'users' ? 'on' : ''}">Users</button><button id="searchGroupsTab" class="${uiState.searchTab === 'groups' ? 'on' : ''}">Groups</button></div></div>
    <input id="globalSearch" placeholder="Search users or groups" value="${escapeHtml(uiState.searchQuery)}" />
    <div class="scroll-list">
      ${uiState.searchTab === 'users'
        ? users.map((u) => `<div class="result"><div class="row"><div class="avatar">${initials(u.username || u.email)}</div><div><div class="name">${u.username || u.email}</div><div class="small">${u.email || ''}</div></div></div><button data-start-dm="${u.id}">Open Chat</button></div>`).join('')
        : groups.map((g) => `<div class="result"><div class="row"><div class="avatar">${initials(g.name)}</div><div><div class="name">${g.name}</div><div class="small">${(g.members || []).length} members</div></div></div>${(g.members || []).includes(meId) ? `<button data-open-group="${g.id}">Open</button>` : `<button data-join-group="${g.id}">Join</button>`}</div>`).join('')}
    </div>
  </div>`;
}

function profilePanel(myProfile, meId) {
  return `<div class="panel-wrap">
    <h3>Profile</h3>
    <div class="profile-card">
      <div class="avatar xl">${initials(myProfile?.username || 'U')}</div>
      <div>
        <div class="name">${myProfile?.username || 'User'}</div>
        <div class="small">${myProfile?.about || 'No about yet'}</div>
      </div>
    </div>
    <label class="small">Username</label>
    <input id="profileUsername" value="${escapeHtml(uiState.profileDraft)}" />
    <button id="saveProfile" class="primary">Edit profile</button>
    <div class="small">Account info: ${myProfile?.email || ''}</div>

    <hr/>
    <h4>Create group</h4>
    <input id="groupName" placeholder="Group name" />
    <select id="groupMembers" multiple size="8">
      ${state.users.filter((u) => u.id !== meId).map((u) => `<option value="${u.id}">${u.username || u.email}</option>`).join('')}
    </select>
    <button id="createGroup">Create group</button>
  </div>`;
}

function notificationsPanel() {
  return `<div class="panel-wrap">
    <div class="row space"><h3>Notifications</h3><button id="markRead">Mark all read</button></div>
    <div class="dropdown-list">
      ${state.notifications.map((n) => `<div class="notif"><div>${n.text}</div><div class="small">${format(n.createdAt)} ${n.read ? '' : '• unread'}</div></div>`).join('') || '<div class="small">No notifications</div>'}
    </div>
  </div>`;
}

function settingsPanel() {
  return `<div class="panel-wrap">
    <h3>Settings</h3>
    <div class="setting-item"><div><strong>Account</strong><div class="small">Manage your session</div></div><button id="logout">Logout</button></div>
  </div>`;
}

function chatWindow(chat, meId) {
  if (!chat) return '<div class="placeholder">Select chat/group from middle list.</div>';
  const msgs = chatMessages(chat.chatRef);
  const typingUsers = state.typing.filter((t) => t.userId !== meId).map((t) => t.username).filter(Boolean);

  return `<div class="chat-col">
    <header class="chat-header row space">
      <div class="row"><div class="avatar">${initials(participantsLabel(chat, meId))}</div><div><div class="name">${participantsLabel(chat, meId)}</div><div class="small">${chatPresenceLabel(chat, meId)}</div></div></div>
      <div class="row"><button id="refreshActiveChat">Refresh</button>${chat.type === 'group' ? '<button id="toggleGroupPanel">Group Info</button>' : ''}</div>
    </header>
    <div class="typing">${typingUsers.length ? `${typingUsers.join(', ')} typing...` : ''}</div>
    <div class="message-area" id="msgs">
      ${msgs.map((m) => `<div class="bubble ${m.senderId === meId ? 'mine' : ''}"><div class="small">${displayNameById(m.senderId)}</div>${m.deleted ? '<i>message deleted</i>' : renderMsgContent(m)}<div class="small">${messageStatus(m, chat, meId)}</div>${m.senderId === meId && !m.deleted ? `<button data-del-msg="${m.id}">Delete</button>` : ''}</div>`).join('')}
    </div>
    <footer class="input-bar">
      <textarea id="messageInput" placeholder="Type message..."></textarea>
      <div class="row controls">
        <button id="emojiBtn">😊</button>
        <label class="file-btn">Image<input id="imageInput" type="file" accept="image/*" /></label>
        <label class="file-btn">Video<input id="videoInput" type="file" accept="video/*" /></label>
        <button id="sendMsg" class="primary">Send</button>
      </div>
    </footer>
    ${chat.type === 'group' ? groupDrawer(chat, meId) : ''}
  </div>`;
}

function groupDrawer(chat, meId) {
  return `<aside class="group-drawer ${uiState.showGroupPanel ? 'open' : ''}">
    <h4>${chat.name}</h4>
    <div class="small">Members</div>
    <div class="members">${(chat.members || []).map((id) => `<div class="member">${displayNameById(id)}</div>`).join('')}</div>
    <button id="leaveGroup" class="danger">Leave group</button>
    <div class="small">Shared media</div>
    <div class="media-grid">${chatMessages(chat.chatRef).filter((m) => ['image', 'video'].includes(m.type) && !m.deleted).slice(-12).reverse().map((m) => m.type === 'image' ? `<img src="${m.content}"/>` : `<video controls src="${m.content}"></video>`).join('') || '<div class="small">No media</div>'}</div>
  </aside>`;
}

function renderMsgContent(m) {
  if (m.type === 'text') return `<p>${escapeHtml(m.content)}</p>`;
  if (m.type === 'image') return `<img src="${m.content}" alt="image"/>`;
  if (m.type === 'video') return `<video controls src="${m.content}"></video>`;
  return '';
}

function escapeHtml(s = '') {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function authHTML() {
  return `<div class="auth-wrap"><div class="auth card"><h2>Doomstalk</h2><div id="authMessage" class="small" style="min-height:18px;"></div><input id="regUsername" placeholder="Username"/><input id="regEmail" type="email" placeholder="Email"/><input id="regPassword" type="password" placeholder="Password"/><button id="register" class="primary">Create account</button><hr/><input id="loginEmail" type="email" placeholder="Email"/><input id="loginPassword" type="password" placeholder="Password"/><button id="login">Login</button><hr/><button id="googleLogin">Continue with Google</button><div class="small" style="text-align:center;margin-top:6px;">Made by kunal - dewangan</div></div></div>`;
}

function setAuthMessage(text, isError = false) {
  const el = document.getElementById('authMessage');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#f87171' : '#8ea0c8';
}

function prettyAuthError(err) {
  const raw = err?.message || String(err || 'Authentication failed');
  if (raw.includes('missing initial state') || raw.includes('sessionStorage is inaccessible')) {
    return 'Google login failed in this browser session. Open this site in normal Chrome (not in-app/incognito), allow cookies, then try again.';
  }
  if (raw.includes('auth/popup-blocked')) {
    return 'Popup was blocked. Please allow popups for this site and try again.';
  }
  return raw;
}

function bindAuth() {
  document.getElementById('register').onclick = async () => {
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    if (!username || !email || !password) return setAuthMessage('Please fill all fields', true);
    setAuthMessage('Creating account...');
    try {
      const cred = await createUserWithEmailAndPassword(firebase.auth, email, password);
      await updateProfile(cred.user, { displayName: username });
      await ensureProfile(cred.user, username);
    } catch (e) { setAuthMessage(e.message, true); }
  };
  document.getElementById('login').onclick = async () => {
    setAuthMessage('Logging in...');
    try {
      const cred = await signInWithEmailAndPassword(firebase.auth, document.getElementById('loginEmail').value.trim(), document.getElementById('loginPassword').value);
      await ensureProfile(cred.user);
    } catch (e) { setAuthMessage(e.message, true); }
  };
  document.getElementById('googleLogin').onclick = async () => {
    setAuthMessage('Connecting Google...');
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });

      // Try popup first even on mobile; redirect is only fallback.
      try {
        const cred = await signInWithPopup(firebase.auth, provider);
        await ensureProfile(cred.user);
        return;
      } catch (popupErr) {
        const msg = String(popupErr?.message || popupErr || '');
        if (!msg.includes('auth/popup') && !msg.includes('popup')) {
          throw popupErr;
        }
      }

      setAuthMessage('Popup blocked, switching to redirect...');
      await signInWithRedirect(firebase.auth, provider);
    } catch (e) { setAuthMessage(prettyAuthError(e), true); }
  };
}

async function createNotification(userId, text, type = 'message', refId = null) {
  await addDoc(collection(firebase.db, 'notifications'), { userId, text, type, refId, read: false, createdAt: serverTimestamp() });
}

function bindMain(activeChat, meId) {
  document.querySelectorAll('[data-section]').forEach((el) => {
    el.onclick = () => {
      uiState.section = el.dataset.section;
      render(false);
    };
  });

  document.querySelectorAll('#logout').forEach((btn) => {
    btn.onclick = async () => {
      try {
        if (activeChatRef) await setTyping(activeChatRef, false);
        await updateDoc(doc(firebase.db, 'users', meId), { online: false, lastSeen: serverTimestamp() });
      } catch (_) {}
      await signOut(firebase.auth);
    };
  });

  const listSearch = document.getElementById('listSearch');
  if (listSearch) listSearch.oninput = (e) => { uiState.listSearch = e.target.value; render(false); };

  document.querySelectorAll('[data-chat]').forEach((el) => {
    el.onclick = async () => {
      if (activeChatRef && activeChatRef !== el.dataset.chat) await setTyping(activeChatRef, false);
      activeChatRef = el.dataset.chat;
      uiState.section = activeChatRef.startsWith('group:') ? 'groups' : 'chats';
      render();
    };
  });

  document.querySelectorAll('[data-refresh-chat]').forEach((el) => {
    el.onclick = async () => refreshChatMessages(el.dataset.refreshChat);
  });

  const gSearch = document.getElementById('globalSearch');
  if (gSearch) gSearch.oninput = (e) => { uiState.searchQuery = e.target.value; render(false); };
  const pUser = document.getElementById('profileUsername');
  if (pUser) pUser.oninput = (e) => { uiState.profileDraft = e.target.value; };

  const usersTab = document.getElementById('searchUsersTab');
  if (usersTab) usersTab.onclick = () => { uiState.searchTab = 'users'; render(false); };
  const groupsTab = document.getElementById('searchGroupsTab');
  if (groupsTab) groupsTab.onclick = () => { uiState.searchTab = 'groups'; render(false); };

  document.querySelectorAll('[data-start-dm]').forEach((el) => {
    el.onclick = async () => {
      const otherId = el.dataset.startDm;
      const existing = state.directChats.find((c) => c.members?.includes(meId) && c.members?.includes(otherId));
      if (existing) activeChatRef = `direct:${existing.id}`;
      else {
        const ref = await addDoc(collection(firebase.db, 'directChats'), { members: [meId, otherId], createdAt: serverTimestamp() });
        activeChatRef = `direct:${ref.id}`;
      }
      uiState.section = 'chats';
      render();
    };
  });

  document.querySelectorAll('[data-open-group]').forEach((el) => {
    el.onclick = () => {
      activeChatRef = `group:${el.dataset.openGroup}`;
      uiState.section = 'groups';
      render();
    };
  });

  document.querySelectorAll('[data-join-group]').forEach((el) => {
    el.onclick = async () => {
      await updateDoc(doc(firebase.db, 'groups', el.dataset.joinGroup), { members: arrayUnion(meId) });
    };
  });

  const saveProfile = document.getElementById('saveProfile');
  if (saveProfile) {
    saveProfile.onclick = async () => {
      const val = uiState.profileDraft.trim();
      if (!val) return alert('Username required');
      await updateDoc(doc(firebase.db, 'users', meId), { username: val });
      alert('Username updated successfully');
    };
  }

  const createGroup = document.getElementById('createGroup');
  if (createGroup) {
    createGroup.onclick = async () => {
      const name = document.getElementById('groupName').value.trim();
      const members = Array.from(document.getElementById('groupMembers').selectedOptions).map((o) => o.value);
      if (!name) return alert('Group name required');
      const ref = await addDoc(collection(firebase.db, 'groups'), { name, members: Array.from(new Set([meId, ...members])), adminId: meId, createdAt: serverTimestamp() });
      for (const m of members) await createNotification(m, `Added to group ${name}`, 'group_add', `group:${ref.id}`);
      alert('Group created');
    };
  }

  const markRead = document.getElementById('markRead');
  if (markRead) {
    markRead.onclick = async () => {
      await Promise.all(state.notifications.filter((n) => !n.read).map((n) => updateDoc(doc(firebase.db, 'notifications', n.id), { read: true })));
    };
  }

  if (!activeChat || !(uiState.section === 'chats' || uiState.section === 'groups')) return;

  const refreshActive = document.getElementById('refreshActiveChat');
  if (refreshActive) refreshActive.onclick = async () => refreshChatMessages(activeChat.chatRef);

  const toggleGroupPanel = document.getElementById('toggleGroupPanel');
  if (toggleGroupPanel) toggleGroupPanel.onclick = () => { uiState.showGroupPanel = !uiState.showGroupPanel; render(false); };

  const leaveGroup = document.getElementById('leaveGroup');
  if (leaveGroup) {
    leaveGroup.onclick = async () => {
      const gid = activeChat.chatRef.split(':')[1];
      await updateDoc(doc(firebase.db, 'groups', gid), { members: arrayRemove(meId) });
      activeChatRef = null;
      uiState.showGroupPanel = false;
      render();
    };
  }

  const msgInput = document.getElementById('messageInput');
  if (msgInput) {
    msgInput.oninput = async () => {
      clearTimeout(typingDebounce);
      await setTyping(activeChat.chatRef, true);
      typingDebounce = setTimeout(() => setTyping(activeChat.chatRef, false), 1800);
    };
    msgInput.onblur = async () => setTyping(activeChat.chatRef, false);
  }

  const emojiBtn = document.getElementById('emojiBtn');
  if (emojiBtn) emojiBtn.onclick = () => {
    const input = document.getElementById('messageInput');
    input.value += '😊';
    input.focus();
  };

  document.getElementById('sendMsg').onclick = async () => {
    const text = document.getElementById('messageInput').value.trim();
    const image = document.getElementById('imageInput').files[0];
    const video = document.getElementById('videoInput').files[0];
    if (!text && !image && !video) return;

    let type = 'text';
    let content = text;
    const media = image || video;
    if (media) {
      content = await fileToDataUrl(media);
      type = media.type.startsWith('image/') ? 'image' : 'video';
    }

    await addDoc(collection(firebase.db, 'messages'), {
      chatRef: activeChat.chatRef,
      senderId: meId,
      type,
      content,
      createdAt: serverTimestamp(),
      seenBy: [meId],
      deleted: false
    });

    for (const id of (activeChat.members || []).filter((id) => id !== meId)) {
      await createNotification(id, `New message from ${displayNameById(meId)}`, 'message', activeChat.chatRef);
    }

    await setTyping(activeChat.chatRef, false);
    document.getElementById('messageInput').value = '';
    document.getElementById('imageInput').value = '';
    document.getElementById('videoInput').value = '';
  };

  document.querySelectorAll('[data-del-msg]').forEach((el) => {
    el.onclick = async () => updateDoc(doc(firebase.db, 'messages', el.dataset.delMsg), { deleted: true });
  });

  const msgs = document.getElementById('msgs');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

if (configured) {
  setPersistence(firebase.auth, browserLocalPersistence).catch(() => {
    // keep default persistence if browser blocks this
  });

  onAuthStateChanged(firebase.auth, async (user) => {
    if (!user) {
      detachListeners();
      state = structuredClone(initialState);
      activeChatRef = null;
      render();
      return;
    }
    await ensureProfile(user);
    attachCoreListeners();
    render();
  });

  getRedirectResult(firebase.auth).then(async (result) => {
    if (result?.user) {
      await ensureProfile(result.user);
    }
  }).catch((err) => {
    if (!currentUser()) {
      render();
      setAuthMessage(prettyAuthError(err), true);
    }
  });
}

window.addEventListener('beforeunload', async () => {
  const me = currentUser();
  if (!me) return;
  try {
    if (activeChatRef) await setTyping(activeChatRef, false);
    await updateDoc(doc(firebase.db, 'users', me.uid), { online: false, lastSeen: serverTimestamp() });
  } catch (_) {}
});

render();
