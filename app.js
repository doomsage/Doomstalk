import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
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

const initialState = {
  users: [],
  directChats: [],
  groups: [],
  notifications: [],
  messages: [],
  typing: []
};

let state = structuredClone(initialState);
let activeChatRef = null;
let activeUnsubMessages = null;
let typingUnsub = null;
let unsubscribeFns = [];
let typingDebounce = null;

let firebase = null;
if (configured) {
  const app = initializeApp(FIREBASE_CONFIG);
  firebase = { app, auth: getAuth(app), db: getFirestore(app) };
}

const currentUser = () => firebase?.auth?.currentUser || null;
const userById = (id) => state.users.find((u) => u.id === id);

const format = (ts) => {
  if (!ts) return '—';
  if (typeof ts === 'string') return new Date(ts).toLocaleString();
  if (ts?.toDate) return ts.toDate().toLocaleString();
  return new Date(ts).toLocaleString();
};

const safeNow = () => Date.now();
const typingDocId = (chatRef, userId) => `${chatRef.replace(':', '_')}_${userId}`;

function chatMessages(chatRef) {
  return state.messages
    .filter((m) => m.chatRef === chatRef)
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
}

function latestTs(chatRef) {
  const msg = state.messages
    .filter((m) => m.chatRef === chatRef)
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))[0];
  return msg?.createdAt?.seconds || 0;
}

function unreadCount(chatRef, meId) {
  return state.messages.filter((m) => m.chatRef === chatRef && m.senderId !== meId && !m.deleted && !(m.seenBy || []).includes(meId)).length;
}

function participantsLabel(chat, meId) {
  if (chat.type === 'group') return chat.name;
  const other = userById((chat.members || []).find((x) => x !== meId));
  if (!other) return 'Unknown user';
  return `${other.username || other.email} (${other.online ? 'online' : `last seen ${format(other.lastSeen)}`})`;
}

async function ensureProfile(user, fallbackName = null) {
  const userRef = doc(firebase.db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    await setDoc(userRef, {
      username: fallbackName || user.displayName || user.email?.split('@')[0] || 'user',
      email: user.email || '',
      provider: user.providerData?.[0]?.providerId || 'password',
      online: true,
      lastSeen: serverTimestamp(),
      createdAt: serverTimestamp()
    });
    return;
  }
  await updateDoc(userRef, { online: true, lastSeen: serverTimestamp() });
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

  const unsubUsers = onSnapshot(collection(firebase.db, 'users'), (snap) => {
    state.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });

  const unsubDirect = onSnapshot(query(collection(firebase.db, 'directChats'), where('members', 'array-contains', me.uid)), (snap) => {
    state.directChats = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });

  const unsubGroups = onSnapshot(query(collection(firebase.db, 'groups'), where('members', 'array-contains', me.uid)), (snap) => {
    state.groups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });

  const unsubNotifs = onSnapshot(
    query(collection(firebase.db, 'notifications'), where('userId', '==', me.uid), orderBy('createdAt', 'desc'), limit(50)),
    (snap) => {
      state.notifications = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );

  unsubscribeFns = [unsubUsers, unsubDirect, unsubGroups, unsubNotifs];
}

function attachMessageListener(chatRef) {
  if (activeUnsubMessages) activeUnsubMessages();
  activeUnsubMessages = onSnapshot(
    query(collection(firebase.db, 'messages'), where('chatRef', '==', chatRef), orderBy('createdAt', 'asc')),
    (snap) => {
      state.messages = [...state.messages.filter((m) => m.chatRef !== chatRef), ...snap.docs.map((d) => ({ id: d.id, ...d.data() }))];
      markSeenInActiveChat();
      render(false);
    }
  );
}

function attachTypingListener(chatRef) {
  if (typingUnsub) typingUnsub();
  typingUnsub = onSnapshot(query(collection(firebase.db, 'typingStatus'), where('chatRef', '==', chatRef)), (snap) => {
    const nowMs = safeNow();
    state.typing = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => nowMs - (t.updatedAtMs || 0) < 5000 && t.isTyping);
    render(false);
  });
}

async function setTyping(chatRef, isTyping) {
  const me = currentUser();
  if (!me || !chatRef) return;
  const profile = userById(me.uid);
  const ref = doc(firebase.db, 'typingStatus', typingDocId(chatRef, me.uid));
  await setDoc(
    ref,
    {
      chatRef,
      userId: me.uid,
      username: profile?.username || me.displayName || me.email || 'user',
      isTyping,
      updatedAtMs: safeNow(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

async function refreshChatMessages(chatRef) {
  const snap = await getDocs(query(collection(firebase.db, 'messages'), where('chatRef', '==', chatRef), orderBy('createdAt', 'asc')));
  state.messages = [...state.messages.filter((m) => m.chatRef !== chatRef), ...snap.docs.map((d) => ({ id: d.id, ...d.data() }))];
  if (chatRef === activeChatRef) {
    await markSeenInActiveChat();
  }
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

function render(checkListeners = true) {
  const root = document.getElementById('app');

  if (!configured) {
    root.innerHTML = `
      <div class="auth-wrap">
        <div class="auth card aurora">
          <h2>Doomstalk needs Firebase config</h2>
          <p class="small">Put your Spark config in <code>firebase-config.js</code> as <code>window.DOOMSTALK_FIREBASE_CONFIG</code>.</p>
          <p class="small">Enable Firebase Auth (Email/Password + Google) and Firestore.</p>
        </div>
      </div>`;
    return;
  }

  const me = currentUser();
  if (!me) {
    root.innerHTML = authHTML();
    bindAuth();
    return;
  }

  const myProfile = userById(me.uid);
  const chats = [
    ...state.directChats.map((c) => ({ ...c, type: 'direct', chatRef: `direct:${c.id}` })),
    ...state.groups.map((g) => ({ ...g, type: 'group', chatRef: `group:${g.id}` }))
  ].sort((a, b) => latestTs(b.chatRef) - latestTs(a.chatRef));

  if (!activeChatRef && chats.length) activeChatRef = chats[0].chatRef;
  const activeChat = chats.find((c) => c.chatRef === activeChatRef) || chats[0] || null;

  if (activeChat && checkListeners) {
    attachMessageListener(activeChat.chatRef);
    attachTypingListener(activeChat.chatRef);
  }

  const searchUsers = (document.getElementById('searchUsers')?.value || '').toLowerCase();
  const searchGroups = (document.getElementById('searchGroups')?.value || '').toLowerCase();
  const filteredUsers = state.users
    .filter((u) => u.id !== me.uid)
    .filter((u) => (u.username || '').toLowerCase().includes(searchUsers) || (u.email || '').toLowerCase().includes(searchUsers));
  const filteredGroups = state.groups.filter((g) => (g.name || '').toLowerCase().includes(searchGroups));

  root.innerHTML = `
  <div class="layout">
    <aside class="sidebar card glass">
      <div class="row space">
        <h3>Doomstalk ✨</h3>
        <span class="pill online">${myProfile?.username || me.displayName || me.email}</span>
      </div>
      <div class="small">${me.email || ''} • Last seen: ${format(myProfile?.lastSeen)}</div>
      <div class="row toolbar">
        <button id="logout" class="danger">Logout</button>
        <button id="markRead">Alerts</button>
        <button id="exportData">Export</button>
      </div>

      <div class="section-title"><span>Chats</span><span class="small">Real-time</span></div>
      <div id="chatList" class="list">${
        chats.length
          ? chats
              .map(
                (c) => `<div class="chat-item ${c.chatRef === activeChat?.chatRef ? 'active' : ''}">
                    <button class="chat-main" data-chat="${c.chatRef}">
                      <div class="row space"><strong>${participantsLabel(c, me.uid)}</strong><span class="badge">${unreadCount(c.chatRef, me.uid)}</span></div>
                      <div class="small">${c.type}</div>
                    </button>
                    <button class="icon-btn" data-refresh-chat="${c.chatRef}" title="Refresh this chat">⟳</button>
                </div>`
              )
              .join('')
          : '<div class="small">No chats yet. Start from user search.</div>'
      }</div>

      <div class="section-title"><span>Search users</span></div>
      <input id="searchUsers" placeholder="username / email" value="${searchUsers}" />
      <div class="list">${filteredUsers
        .slice(0, 8)
        .map(
          (u) => `<div class="chat-item compact"><div class="row space"><span>${u.username || u.email}</span><span class="${u.online ? 'online' : 'offline'}">${
            u.online ? 'online' : 'offline'
          }</span></div><button data-dm="${u.id}">Start DM</button></div>`
        )
        .join('')}</div>

      <div class="section-title"><span>Search groups</span></div>
      <input id="searchGroups" placeholder="group name" value="${searchGroups}" />
      <div class="list">${filteredGroups
        .slice(0, 8)
        .map(
          (g) => `<div class="chat-item compact"><div>${g.name}</div><div class="small">Members: ${(g.members || []).length}</div>${
            (g.members || []).includes(me.uid) ? `<button data-open-group="${g.id}">Open</button>` : `<span class="small">Not a member</span>`
          }</div>`
        )
        .join('')}</div>
    </aside>

    <main class="main card glass">
      ${activeChat ? chatPane(activeChat, me.uid) : '<div class="empty">Select any chat to start messaging.</div>'}
    </main>

    <aside class="rightbar card glass">
      <div class="section-title"><span>Profile</span></div>
      <div class="grid">
        <input id="profileUsername" value="${myProfile?.username || ''}" />
        <button id="saveProfile" class="primary">Update Username</button>
      </div>

      <div class="section-title"><span>Create group</span></div>
      <input id="groupName" placeholder="Group name" />
      <select id="groupMembers" multiple size="7">
        ${state.users
          .filter((u) => u.id !== me.uid)
          .map((u) => `<option value="${u.id}">${u.username || u.email}</option>`)
          .join('')}
      </select>
      <button id="createGroup" class="primary">Create Group</button>

      <div class="section-title"><span>Notifications</span><span class="badge">${state.notifications.filter((n) => !n.read).length}</span></div>
      <div class="list">${
        state.notifications.length
          ? state.notifications
              .map((n) => `<div class="chat-item compact"><div>${n.text}</div><div class="small">${format(n.createdAt)} ${n.read ? '' : '• unread'}</div></div>`)
              .join('')
          : '<div class="small">No notifications</div>'
      }</div>

      <div class="section-title"><span>Shared media</span></div>
      <div class="list">${activeChat ? mediaGallery(activeChat.chatRef) : '<div class="small">Open a chat</div>'}</div>
    </aside>
  </div>`;

  bindMain(activeChat, me.uid);
}

function mediaGallery(chatRef) {
  const media = chatMessages(chatRef).filter((m) => ['image', 'video'].includes(m.type) && !m.deleted);
  if (!media.length) return '<div class="small">No media yet.</div>';
  return media
    .slice(-8)
    .reverse()
    .map((m) => (m.type === 'image' ? `<img src="${m.content}" alt="img"/>` : `<video controls src="${m.content}"></video>`))
    .join('');
}

function chatPane(chat, meId) {
  const msgs = chatMessages(chat.chatRef);
  const typingUsers = state.typing.filter((t) => t.userId !== meId).map((t) => t.username).filter(Boolean);

  return `
    <div class="chat-head">
      <div>
        <h2>${participantsLabel(chat, meId)}</h2>
        <div class="small">${chat.type === 'group' ? `Members: ${(chat.members || []).map((id) => userById(id)?.username || userById(id)?.email || id).join(', ')}` : 'Direct chat'}</div>
      </div>
      <div class="row">
        <button id="refreshActiveChat" title="Refresh active chat">⟳ Refresh</button>
        ${chat.type === 'group' ? '<button id="leaveGroup">Leave group</button>' : ''}
        ${chat.type === 'group' ? '<button id="manageMembers">Manage members</button>' : ''}
      </div>
    </div>
    <div class="typing-line">${typingUsers.length ? `${typingUsers.join(', ')} typing...` : ' '}</div>
    <div class="msgs" id="msgs">
      ${msgs
        .map(
          (m) => `<div class="msg ${m.senderId === meId ? 'mine' : ''}">
          <div class="small">${userById(m.senderId)?.username || userById(m.senderId)?.email || 'Unknown'} • ${format(m.createdAt)}</div>
          ${m.deleted ? '<i>message deleted</i>' : renderMsgContent(m)}
          <div class="row space">
            <span class="small">${m.senderId === meId ? deliveryStatus(m, meId, chat) : ''}</span>
            ${m.senderId === meId && !m.deleted ? `<button data-del-msg="${m.id}">Delete</button>` : ''}
          </div>
        </div>`
        )
        .join('')}
    </div>
    <div class="grid">
      <textarea id="messageInput" placeholder="Write a message..."></textarea>
      <div class="row">
        <input type="file" id="mediaInput" accept="image/*,video/*" />
        <button id="sendMsg" class="primary">Send</button>
      </div>
    </div>
  `;
}

function deliveryStatus(msg, meId, chat) {
  if (msg.senderId !== meId) return '';
  if (chat.type === 'group') {
    const total = (chat.members || []).length - 1;
    const seen = (msg.seenBy || []).filter((id) => id !== meId).length;
    return seen >= total ? 'seen' : 'delivered';
  }
  const otherId = (chat.members || []).find((id) => id !== meId);
  return (msg.seenBy || []).includes(otherId) ? 'seen' : 'delivered';
}

function renderMsgContent(m) {
  if (m.type === 'text') return `<p>${escapeHtml(m.content)}</p>`;
  if (m.type === 'image') return `<img src="${m.content}" alt="image"/>`;
  if (m.type === 'video') return `<video controls src="${m.content}"></video>`;
  return '';
}

function escapeHtml(s = '') {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function authHTML() {
  return `
    <div class="auth-wrap">
      <div class="auth card aurora">
        <h1>Doomstalk</h1>
        <div class="small">Firebase-powered realtime chat.</div>
        <input id="regUsername" placeholder="Username" />
        <input id="regEmail" type="email" placeholder="Email" />
        <input id="regPassword" type="password" placeholder="Password" />
        <button class="primary" id="register">Create account</button>

        <hr/>

        <input id="loginEmail" type="email" placeholder="Email" />
        <input id="loginPassword" type="password" placeholder="Password" />
        <button id="login">Login</button>

        <hr/>
        <button id="googleLogin">Continue with Google</button>
      </div>
    </div>`;
}

function bindAuth() {
  document.getElementById('register').onclick = async () => {
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    if (!username || !email || !password) return alert('Fill all registration fields.');
    try {
      const cred = await createUserWithEmailAndPassword(firebase.auth, email, password);
      await updateProfile(cred.user, { displayName: username });
      await ensureProfile(cred.user, username);
    } catch (e) {
      alert(e.message);
    }
  };

  document.getElementById('login').onclick = async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
      const cred = await signInWithEmailAndPassword(firebase.auth, email, password);
      await ensureProfile(cred.user);
    } catch (e) {
      alert(e.message);
    }
  };

  document.getElementById('googleLogin').onclick = async () => {
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(firebase.auth, provider);
      await ensureProfile(cred.user);
    } catch (e) {
      alert(e.message);
    }
  };
}

async function createNotification(userId, text, type = 'message', refId = null) {
  await addDoc(collection(firebase.db, 'notifications'), {
    userId,
    type,
    text,
    refId,
    read: false,
    createdAt: serverTimestamp()
  });
}

async function bindMain(activeChat, meId) {
  document.getElementById('logout').onclick = async () => {
    try {
      if (activeChatRef) await setTyping(activeChatRef, false);
      await updateDoc(doc(firebase.db, 'users', meId), { online: false, lastSeen: serverTimestamp() });
    } catch (_) {}
    await signOut(firebase.auth);
  };

  document.getElementById('markRead').onclick = async () => {
    const updates = state.notifications.filter((n) => !n.read).map((n) => updateDoc(doc(firebase.db, 'notifications', n.id), { read: true }));
    await Promise.all(updates);
  };

  document.getElementById('exportData').onclick = async () => {
    const [usersSnap, directSnap, groupsSnap, messagesSnap, notifSnap] = await Promise.all([
      getDocs(collection(firebase.db, 'users')),
      getDocs(collection(firebase.db, 'directChats')),
      getDocs(collection(firebase.db, 'groups')),
      getDocs(collection(firebase.db, 'messages')),
      getDocs(query(collection(firebase.db, 'notifications'), where('userId', '==', meId)))
    ]);
    const data = {
      users: usersSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      directChats: directSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      groups: groupsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      messages: messagesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      notifications: notifSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `doomstalk-firebase-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('saveProfile').onclick = async () => {
    const val = document.getElementById('profileUsername').value.trim();
    if (!val) return alert('Username required');
    await updateDoc(doc(firebase.db, 'users', meId), { username: val });
  };

  document.getElementById('createGroup').onclick = async () => {
    const name = document.getElementById('groupName').value.trim();
    const members = Array.from(document.getElementById('groupMembers').selectedOptions).map((o) => o.value);
    if (!name) return alert('Group name required');
    const finalMembers = Array.from(new Set([meId, ...members]));
    const groupRef = await addDoc(collection(firebase.db, 'groups'), {
      name,
      members: finalMembers,
      adminId: meId,
      createdAt: serverTimestamp()
    });
    for (const memberId of members) {
      await createNotification(memberId, `You were added to group ${name}`, 'group_add', `group:${groupRef.id}`);
    }
    activeChatRef = `group:${groupRef.id}`;
    render();
  };

  document.querySelectorAll('[data-chat]').forEach((el) => {
    el.onclick = async () => {
      if (activeChatRef && activeChatRef !== el.dataset.chat) await setTyping(activeChatRef, false);
      activeChatRef = el.dataset.chat;
      render();
    };
  });

  document.querySelectorAll('[data-refresh-chat]').forEach((el) => {
    el.onclick = async () => {
      await refreshChatMessages(el.dataset.refreshChat);
    };
  });

  document.querySelectorAll('[data-open-group]').forEach((el) => {
    el.onclick = async () => {
      if (activeChatRef && activeChatRef !== `group:${el.dataset.openGroup}`) await setTyping(activeChatRef, false);
      activeChatRef = `group:${el.dataset.openGroup}`;
      render();
    };
  });

  document.querySelectorAll('[data-dm]').forEach((el) => {
    el.onclick = async () => {
      const otherId = el.dataset.dm;
      const existing = state.directChats.find((c) => c.members?.includes(meId) && c.members?.includes(otherId));
      if (existing) {
        activeChatRef = `direct:${existing.id}`;
        render();
        return;
      }
      const ref = await addDoc(collection(firebase.db, 'directChats'), { members: [meId, otherId], createdAt: serverTimestamp() });
      activeChatRef = `direct:${ref.id}`;
      render();
    };
  });

  const su = document.getElementById('searchUsers');
  const sg = document.getElementById('searchGroups');
  if (su) su.oninput = () => render(false);
  if (sg) sg.oninput = () => render(false);

  if (!activeChat) return;

  const refreshActiveChat = document.getElementById('refreshActiveChat');
  if (refreshActiveChat) {
    refreshActiveChat.onclick = async () => {
      await refreshChatMessages(activeChat.chatRef);
    };
  }

  const msgInput = document.getElementById('messageInput');
  if (msgInput) {
    msgInput.oninput = async () => {
      clearTimeout(typingDebounce);
      await setTyping(activeChat.chatRef, true);
      typingDebounce = setTimeout(() => setTyping(activeChat.chatRef, false), 1600);
    };
    msgInput.onblur = async () => setTyping(activeChat.chatRef, false);
  }

  document.getElementById('sendMsg').onclick = async () => {
    const text = document.getElementById('messageInput').value.trim();
    const fileInput = document.getElementById('mediaInput');
    const file = fileInput.files[0];
    if (!text && !file) return;

    let type = 'text';
    let content = text;
    if (file) {
      content = await fileToDataUrl(file);
      if (file.type.startsWith('image/')) type = 'image';
      else if (file.type.startsWith('video/')) type = 'video';
      else return alert('Only image/video supported');
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

    const recipients = (activeChat.members || []).filter((id) => id !== meId);
    for (const id of recipients) {
      await createNotification(id, `New message from ${userById(meId)?.username || currentUser()?.email}`, 'message', activeChat.chatRef);
    }

    await setTyping(activeChat.chatRef, false);
    document.getElementById('messageInput').value = '';
    fileInput.value = '';
  };

  document.querySelectorAll('[data-del-msg]').forEach((el) => {
    el.onclick = async () => updateDoc(doc(firebase.db, 'messages', el.dataset.delMsg), { deleted: true });
  });

  const leaveBtn = document.getElementById('leaveGroup');
  if (leaveBtn) {
    leaveBtn.onclick = async () => {
      const gid = activeChat.chatRef.split(':')[1];
      await updateDoc(doc(firebase.db, 'groups', gid), { members: arrayRemove(meId) });
      activeChatRef = null;
      render();
    };
  }

  const manageBtn = document.getElementById('manageMembers');
  if (manageBtn) {
    manageBtn.onclick = async () => {
      const gid = activeChat.chatRef.split(':')[1];
      const g = state.groups.find((x) => x.id === gid);
      if (!g || g.adminId !== meId) return alert('Only group creator can manage members');
      const input = prompt('Enter usernames to toggle in group, comma separated');
      if (!input) return;
      const names = input.split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of names) {
        const u = state.users.find((x) => (x.username || '').toLowerCase() === name.toLowerCase());
        if (!u) continue;
        if ((g.members || []).includes(u.id)) await updateDoc(doc(firebase.db, 'groups', g.id), { members: arrayRemove(u.id) });
        else {
          await updateDoc(doc(firebase.db, 'groups', g.id), { members: arrayUnion(u.id) });
          await createNotification(u.id, `${userById(meId)?.username || 'Someone'} added you to group ${g.name}`, 'group_add', `group:${g.id}`);
        }
      }
    };
  }

  const msgWrap = document.getElementById('msgs');
  if (msgWrap) msgWrap.scrollTop = msgWrap.scrollHeight;
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
}

window.addEventListener('beforeunload', async () => {
  const me = currentUser();
  if (!me) return;
  try {
    if (activeChatRef) await setTyping(activeChatRef, false);
    await updateDoc(doc(firebase.db, 'users', me.uid), { online: false, lastSeen: serverTimestamp() });
  } catch (_) {}
});

setInterval(() => {
  const nowMs = safeNow();
  state.typing = state.typing.filter((t) => t.isTyping && nowMs - (t.updatedAtMs || 0) < 5000);
  if (currentUser()) render(false);
}, 3000);

render();
