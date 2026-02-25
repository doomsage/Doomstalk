# Doomstalk (Firebase Website Chat)

Doomstalk is now a fully website-based chat app using:
- **Firebase Authentication** (Email/Password + real Google Sign-In)
- **Cloud Firestore** (Spark/free plan)

## 1) Run locally

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## 2) Firebase (Spark) setup

1. Create a Firebase project (Spark/free).
2. Enable **Authentication** providers:
   - Email/Password
   - Google
3. Create **Cloud Firestore** in production or test mode.
4. In Firebase console, copy web app config and paste into `firebase-config.js` (this repo is currently prefilled for `doomstalk-doomsage`).
5. Add `localhost` to authorized domains (Auth settings) if needed.

## 3) What it can do

### Accounts
- Register with username + email + password
- Login/logout
- Real Google sign-in through Firebase popup (desktop) and redirect flow (mobile)
- Presence status (`online`) and `lastSeen`
- Inline auth status/error feedback on login screen
- If Google auth shows `missing initial state`, open in normal Chrome/Safari (not in-app browser/incognito) and allow cookies

### Direct chat
- Start 1:1 chats
- Send text messages
- Send image/video messages
- Seen/delivered indicators
- Delete own messages (soft delete)
- Firebase-synced typing indicator
- Per-chat manual refresh button (along with live updates)

### Group chat
- Create groups with names
- Add/remove members
- Leave group
- Visible member list and history

### Search
- Search users
- Search groups

### Notifications
- New message alerts
- Added-to-group alerts
- Mark read

### Profile
- View and update username

### Media
- View media in active chat media panel

### Utility
- Export app data snapshot JSON
- Responsive UI (phone + PC)
- Enhanced glassmorphism UI with smoother animations and upgraded layout
- Dedicated sections/tabs: **Messages**, **Search**, and **Profile Settings** (not all mixed in one page)
- Input typing stability improved (search/profile inputs no longer lose text on first keystroke)
- New 3-column layout with sticky left navigation, middle list panel, and right chat window
- Search, Profile, Notifications, and Settings now each have separate focused panel flows
- Group chats include a sliding info panel with members, leave button, and shared media preview
- Dark premium color palette with smooth hover/focus transitions across panels, cards, inputs, and buttons

## 4) What it still cannot do (current limitations)

- No Firebase Storage upload pipeline yet (media currently stored as data URLs in Firestore docs, which is not ideal for large files).
- No FCM push notifications (alerts are in-app only).
- Typing indicator sync is implemented; however stale typing documents can remain if browser/process crashes.
- No pagination/virtualization for large histories.
- No role system beyond group creator checks.
- No end-to-end encryption.
- No admin dashboard/moderation tools.
- Firestore security rules are not included in this repo yet; you should add strict rules before production use.

## 5) Recommended next upgrades

- Move media to Firebase Storage + signed URLs.
- Add Firestore security rules and indexes.
- Add FCM web push notifications.
- Add message pagination and lazy-loading.
- Add typing presence in Firestore (ephemeral collection with TTL-like cleanup).
