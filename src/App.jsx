import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, CheckCheck, ChevronDown,
  CircleHelp, FilePlus2, ImagePlus, LockKeyhole, LogOut, MessageCircle, MoreHorizontal,
  Pencil, Plus, Search, Send, Settings2, Shield, ShieldAlert, Sparkles, Trash2,
  Users, X,
} from "lucide-react";

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: options.body instanceof FormData || typeof options.body === "string"
      ? options.body
      : options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function Avatar({ user, size = "md", className = "" }) {
  const name = user?.username || "N";
  return (
    <div className={`avatar avatar-${size} ${className}`}>
      {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span>{name.slice(0, 1).toUpperCase()}</span>}
      {user?.isOnline && <i className="online-dot" />}
    </div>
  );
}

function AuthScreen({ onAuth }) {
  const [tab, setTab] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    if (tab === "register" && password !== confirm) return setMessage("Your passwords do not match.");
    if (tab === "register" && password.length < 8) return setMessage("Use at least 8 characters for your password.");
    setBusy(true);
    try {
      const { user } = await request(`/api/auth/${tab}`, {
        method: "POST",
        body: { username, password, ...(tab === "login" && twoFactorCode ? { twoFactorCode } : {}) },
      });
      onAuth(user);
    } catch (error) {
      setMessage(error.message);
      if (error.message.includes("two-factor")) {
        setRequiresTwoFactor(true);
        setTwoFactorCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function askForReset(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await request("/api/auth/password-reset/request", { method: "POST", body: { username } });
      setMessage(result.message);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-backdrop" />
      <div className="auth-card">
        <div className="auth-brand"><span className="brand-mark"><MessageCircle size={21} /></span><span>NEXORA</span></div>
        <div className="auth-kicker"><span className="pulse" /> YOUR SPACE, IN REAL TIME</div>
        <h1>Conversations<br /><em>without distance.</em></h1>
        <p className="auth-lede">A calmer place for the people and ideas you care about.</p>
        <div className="auth-tabs">
          <button className={tab === "login" ? "selected" : ""} onClick={() => { setTab("login"); setForgot(false); setMessage(""); }}>LOGIN</button>
          <button className={tab === "register" ? "selected" : ""} onClick={() => { setTab("register"); setForgot(false); setMessage(""); }}>REGISTER</button>
        </div>
        {forgot ? (
          <form onSubmit={askForReset} className="auth-form">
            <label>USERNAME<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={20} /></label>
            <div className="notice"><Shield size={15} /> An administrator will review your password reset request.</div>
            {message && <div className="form-message">{message}</div>}
            <button className="primary-button" disabled={busy}>{busy ? "SENDING…" : "REQUEST RESET"} <ArrowUpRight size={17} /></button>
            <button type="button" className="text-button" onClick={() => { setForgot(false); setMessage(""); }}>Back to login</button>
          </form>
        ) : (
          <form onSubmit={submit} className="auth-form">
            <label>USERNAME
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]+" />
              {tab === "register" && <small>3–20 characters · letters, numbers, underscores</small>}
            </label>
            <label>PASSWORD<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={tab === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={72} /></label>
            {tab === "register" && <label>CONFIRM PASSWORD<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required /></label>}
            {tab === "login" && requiresTwoFactor && <label>AUTHENTICATOR CODE<input value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" /></label>}
            {message && <div className="form-message">{message}</div>}
            <button className="primary-button" disabled={busy}>{busy ? "PLEASE WAIT…" : tab === "login" ? "SIGN IN" : "CREATE ACCOUNT"} <ArrowUpRight size={17} /></button>
            {tab === "login" && <button type="button" className="text-button" onClick={() => { setForgot(true); setMessage(""); }}>Forgot your password?</button>}
          </form>
        )}
        <div className="auth-footer"><LockKeyhole size={13} /> Private by design <span>·</span> Encrypted in transit</div>
      </div>
      <div className="auth-side-note"><Sparkles size={16} /> Pick up where your people are.</div>
    </div>
  );
}

function ProfileModal({ user, close, onSaved, socket }) {
  const [username, setUsername] = useState(user.username);
  const [bio, setBio] = useState(user.bio || "");
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [twoFactor, setTwoFactor] = useState(null);
  const [code, setCode] = useState("");
  const [blockedUsers, setBlockedUsers] = useState([]);
  const fileRef = useRef(null);

  useEffect(() => {
    request("/api/users/blocked").then(({ users }) => setBlockedUsers(users)).catch((error) => setMessage(error.message));
  }, []);

  async function uploadAvatar(file) {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await request("/api/uploads", { method: "POST", body: form });
      setAvatarUrl(result.url);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await request("/api/users/me", { method: "PATCH", body: { username, bio, avatarUrl: avatarUrl || null } });
      onSaved(result.user);
      setMessage("Profile saved.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function startTwoFactor() {
    setMessage("");
    try {
      setTwoFactor(await request("/api/auth/2fa/setup", { method: "POST", body: {} }));
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function toggleTwoFactor(event) {
    event.preventDefault();
    setMessage("");
    try {
      const action = user.twoFactorEnabled ? "disable" : "enable";
      const result = await request(`/api/auth/2fa/${action}`, { method: "POST", body: { code } });
      onSaved(result.user);
      setTwoFactor(null);
      setCode("");
      setMessage(user.twoFactorEnabled ? "Two-factor authentication disabled." : "Two-factor authentication enabled.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function unblock(userId) {
    try {
      await request(`/api/users/${userId}/block`, { method: "DELETE" });
      setBlockedUsers((items) => items.filter((item) => item.id !== userId));
    } catch (error) { setMessage(error.message); }
  }

  async function changePassword(event) {
    event.preventDefault();
    setMessage("");
    try {
      const result = await request("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword, socketId: socket?.id },
      });
      setCurrentPassword("");
      setNewPassword("");
      setMessage(result.message);
    } catch (error) { setMessage(error.message); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal-panel profile-panel">
        <div className="modal-heading"><div><span className="eyebrow">YOUR ACCOUNT</span><h2>Profile & security</h2></div><button className="icon-button" onClick={close}><X size={18} /></button></div>
        <form className="profile-form" onSubmit={saveProfile}>
          <div className="avatar-edit"><Avatar user={{ username, avatarUrl }} size="xl" /><button type="button" className="avatar-edit-button" onClick={() => fileRef.current?.click()}><ImagePlus size={14} /> Change photo</button><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => uploadAvatar(e.target.files?.[0])} /></div>
          <label>USERNAME<input value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} maxLength={20} pattern="[A-Za-z0-9_]+" required /></label>
          <label>ABOUT YOU<textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={160} placeholder="A little about you…" rows={3} /></label>
          <button className="primary-button" disabled={busy}>{busy ? "SAVING…" : "SAVE PROFILE"} <Check size={16} /></button>
        </form>
        <div className="security-setting"><div><span className="setting-icon"><Shield size={17} /></span><span><strong>Two-factor authentication</strong><small>{user.twoFactorEnabled ? "Your account has an extra layer of protection." : "Add a verification code when you sign in."}</small></span></div><button className="outline-button" onClick={user.twoFactorEnabled ? () => setTwoFactor({ disable: true }) : startTwoFactor}>{user.twoFactorEnabled ? "Manage" : "Set up"}</button></div>
        <form className="password-change" onSubmit={changePassword}>
          <strong>Change password</strong>
          <input type="password" autoComplete="current-password" placeholder="Current password" minLength={1} maxLength={72} required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          <input type="password" autoComplete="new-password" placeholder="New password · 8 characters minimum" minLength={8} maxLength={72} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <button className="outline-button">Update password</button>
        </form>
        <div className="blocked-section"><div><strong>Blocked people</strong><small>They can’t start a direct conversation with you.</small></div>{blockedUsers.length === 0 ? <span className="blocked-empty">No one blocked</span> : blockedUsers.map((item) => <div className="blocked-user" key={item.id}><Avatar user={item} size="sm" /><strong>@{item.username}</strong><button className="outline-button" onClick={() => unblock(item.id)}>Unblock</button></div>)}</div>
        {twoFactor?.qrCode && <div className="two-factor-setup"><img src={twoFactor.qrCode} alt="Authenticator QR code" /><p>Scan in your authenticator app, then enter the 6-digit code.</p><code>{twoFactor.secret}</code><form onSubmit={toggleTwoFactor}><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="000000" required minLength={6} /><button className="primary-button">Enable 2FA</button></form></div>}
        {twoFactor?.disable && <form className="two-factor-setup" onSubmit={toggleTwoFactor}><p>Enter your current authenticator code to turn off two-factor authentication.</p><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="000000" required minLength={6} /><button className="outline-button">Confirm</button></form>}
        {message && <div className="form-message">{message}</div>}
      </div>
    </div>
  );
}

function AdminPanel({ close, notify }) {
  const [view, setView] = useState("reports");
  const [reports, setReports] = useState([]);
  const [users, setUsers] = useState([]);
  const [resetRequests, setResetRequests] = useState([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      if (view === "reports") {
        const [reportResult, resetResult] = await Promise.all([
          request("/api/admin/reports"),
          request("/api/admin/password-reset-requests"),
        ]);
        setReports(reportResult.reports);
        setResetRequests(resetResult.requests);
      } else {
        setUsers((await request(`/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`)).users);
      }
    } catch (error) {
      notify(error.message);
    }
  }, [view, query, notify]);

  useEffect(() => { refresh(); }, [refresh]);

  async function updateReport(id, status) {
    try {
      await request(`/api/admin/reports/${id}`, { method: "PATCH", body: { status } });
      await refresh();
    } catch (error) { notify(error.message); }
  }

  async function banUser(user) {
    const isBanned = !user.isBanned;
    if (!window.confirm(`${isBanned ? "Ban" : "Unban"} @${user.username}?`)) return;
    try {
      await request(`/api/admin/users/${user.id}`, { method: "PATCH", body: { isBanned } });
      await refresh();
    } catch (error) { notify(error.message); }
  }

  async function resetPassword(user) {
    const temporaryPassword = window.prompt(`Set a temporary password for @${user.username} (at least 8 characters). Share it using a secure channel.`);
    if (!temporaryPassword) return;
    setBusy(true);
    try {
      const response = await request(`/api/admin/users/${user.id}/password`, { method: "POST", body: { temporaryPassword } });
      notify(response.message);
    } catch (error) { notify(error.message); } finally { setBusy(false); }
  }

  async function resetTwoFactor(user) {
    if (!window.confirm(`Reset two-factor authentication for @${user.username}?`)) return;
    try {
      const response = await request(`/api/admin/users/${user.id}/2fa/reset`, { method: "POST", body: {} });
      notify(response.message);
      await refresh();
    } catch (error) { notify(error.message); }
  }

  async function resolveReset(item) {
    const temporaryPassword = window.prompt(`Set a temporary password for @${item.username} (at least 8 characters). Share it using a secure channel.`);
    if (!temporaryPassword) return;
    try {
      const result = await request(`/api/admin/password-reset-requests/${item.id}/resolve`, { method: "POST", body: { temporaryPassword } });
      notify(result.message);
      await refresh();
    } catch (error) { notify(error.message); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal-panel admin-panel">
        <div className="modal-heading"><div><span className="eyebrow">NEXORA CONTROL ROOM</span><h2>Admin dashboard</h2></div><button className="icon-button" onClick={close}><X size={18} /></button></div>
        <div className="admin-tabs"><button className={view === "reports" ? "active" : ""} onClick={() => setView("reports")}><ShieldAlert size={15} /> Reports</button><button className={view === "users" ? "active" : ""} onClick={() => setView("users")}><Users size={15} /> Users</button></div>
        {view === "reports" ? <div className="admin-list">
          <h3>Open reports <span>{reports.filter((item) => item.status === "OPEN").length}</span></h3>
          {reports.length === 0 && <div className="empty-note">No reports yet. Nice and quiet.</div>}
          {reports.map((report) => <div className="report-card" key={report.id}><div className="report-top"><strong>@{report.reportedUser.username}</strong><time>{new Date(report.createdAt).toLocaleString()}</time><span className={`status-tag ${report.status.toLowerCase()}`}>{report.status}</span></div><p>{report.reason}</p><small>Reported by @{report.reporter.username}</small>{report.status === "OPEN" && <div className="report-actions"><button onClick={() => updateReport(report.id, "REVIEWED")}>Mark reviewed</button><button onClick={() => updateReport(report.id, "DISMISSED")}>Dismiss</button></div>}</div>)}
          <h3 className="reset-heading">Password reset requests <span>{resetRequests.length}</span></h3>
          {resetRequests.map((item) => <div className="reset-row" key={item.id}><span>@{item.username}<small>{new Date(item.createdAt).toLocaleString()}</small></span><button className="outline-button" onClick={() => resolveReset(item)}>Review</button></div>)}
        </div> : <div className="admin-list">
          <div className="admin-search"><Search size={16} /><input placeholder="Find a username…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          {users.map((user) => <div className="admin-user" key={user.id}><div><strong>@{user.username}</strong><small>Joined {new Date(user.createdAt).toLocaleDateString()} {user.isAdmin && "· Admin"}</small></div><button className="outline-button" disabled={busy} onClick={() => resetPassword(user)}>Reset password</button>{user.twoFactorEnabled && <button className="outline-button" onClick={() => resetTwoFactor(user)}>Reset 2FA</button>}<button className={user.isBanned ? "outline-button" : "danger-button"} onClick={() => banUser(user)}>{user.isBanned ? "Unban" : "Ban"}</button></div>)}
        </div>}
      </div>
    </div>
  );
}

function FriendsPanel({ friends, incomingRequests, outgoingRequests, close, onAccept, onReject, onRemove, onChat }) {
  const [tab, setTab] = useState("friends");
  const lists = {
    friends: friends.map((user) => ({ id: user.id, user })),
    incoming: incomingRequests,
    outgoing: outgoingRequests,
  };
  const items = lists[tab];
  const emptyMessages = {
    friends: "Search for someone by their exact username to connect.",
    incoming: "You’re all caught up.",
    outgoing: "You haven’t sent any friend requests.",
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal-panel friends-panel">
        <div className="modal-heading"><div><span className="eyebrow">YOUR PEOPLE</span><h2>Friends & requests</h2></div><button className="icon-button" onClick={close} aria-label="Close friends"><X size={18} /></button></div>
        <div className="admin-tabs friends-tabs">
          <button className={tab === "friends" ? "active" : ""} onClick={() => setTab("friends")}>Friends <span>{friends.length}</span></button>
          <button className={tab === "incoming" ? "active" : ""} onClick={() => setTab("incoming")}>Incoming <span>{incomingRequests.length}</span></button>
          <button className={tab === "outgoing" ? "active" : ""} onClick={() => setTab("outgoing")}>Sent <span>{outgoingRequests.length}</span></button>
        </div>
        <div className="friend-list">
          {items.map((item) => (
            <div className="friend-row" key={item.id}>
              <Avatar user={item.user} size="sm" />
              <div className="friend-copy"><strong>@{item.user.username}</strong><small>{tab === "friends" ? item.user.isOnline ? "Online now" : "Friend" : tab === "incoming" ? "Sent you a friend request" : "Friend request pending"}</small></div>
              <div className="friend-actions">
                {tab === "friends" && <><button className="outline-button" onClick={() => { onChat(item.user); close(); }}>Message</button><button className="danger-button" onClick={() => onRemove(item.user)}>Remove</button></>}
                {tab === "incoming" && <><button className="outline-button" onClick={() => onAccept(item.id)}>Accept</button><button className="danger-button" onClick={() => onReject(item.id)}>Reject</button></>}
              </div>
            </div>
          ))}
          {!items.length && <div className="friends-empty"><Users size={20} /><span>{emptyMessages[tab]}</span></div>}
        </div>
      </div>
    </div>
  );
}

function MessageItem({ message, currentUser, onEdit, onDelete, onReport }) {
  const mine = message.senderId === currentUser.id;
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(message.content);

  async function saveEdit(event) {
    event.preventDefault();
    await onEdit(message.id, content);
    setEditing(false);
  }
  const read = message.reads?.some((item) => item.userId !== currentUser.id);

  return (
    <div className={`message-row ${mine ? "mine" : ""}`}>
      {!mine && <Avatar user={message.sender} size="sm" />}
      <div className="message-content">
        {!mine && <div className="message-author">{message.sender.username}</div>}
        {editing ? <form className="edit-message" onSubmit={saveEdit}><input value={content} onChange={(e) => setContent(e.target.value)} autoFocus maxLength={4000} /><button><Check size={15} /></button><button type="button" onClick={() => setEditing(false)}><X size={15} /></button></form> : (
          <div className={`bubble ${message.deletedAt ? "deleted" : ""}`}>
            {message.deletedAt ? <i>This message was deleted</i> : <>
              {message.attachmentUrl && (message.attachmentType?.startsWith("image/") ? <a className="shared-image-link" href={message.attachmentUrl} target="_blank" rel="noreferrer"><img className="shared-image" src={message.attachmentUrl} alt={message.attachmentName || "Shared image"} /></a> : <a className="attachment" href={message.attachmentUrl} target="_blank" rel="noreferrer"><FilePlus2 size={16} /><span>{message.attachmentName || "Shared file"}<small>{message.attachmentType || "Attachment"}</small></span><ArrowUpRight size={15} /></a>)}
              {message.content && <p>{message.content}</p>}
            </>}
          </div>
        )}
        {!message.deletedAt && <div className="message-meta"><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{message.editedAt && <span>edited</span>}{mine && (read ? <CheckCheck size={13} className="read-icon" /> : <Check size={13} />)}</div>}
      </div>
      <div className="message-actions">
        <button className="icon-button tiny" onClick={() => setMenu(!menu)} aria-label="Message options"><MoreHorizontal size={16} /></button>
        {menu && <div className="message-menu">{mine ? <><button onClick={() => { setEditing(true); setMenu(false); }}><Pencil size={14} /> Edit</button><button className="danger-text" onClick={() => { onDelete(message.id); setMenu(false); }}><Trash2 size={14} /> Delete</button></> : <button onClick={() => { onReport(message); setMenu(false); }}><ShieldAlert size={14} /> Report</button>}</div>}
      </div>
    </div>
  );
}

function ChatView({ user, conversation, messages, typing, hasMore, loadingOlder, onLoadOlder, onEdit, onDelete, onReport, onBlock, socket }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const messagesRef = useRef(null);
  const typingTimer = useRef(null);
  const stickToBottom = useRef(true);
  const scrollRestore = useRef(null);
  const title = conversation.type === "GROUP" ? conversation.title : conversation.displayUser?.username || "Conversation";
  const other = conversation.displayUser;

  useLayoutEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    if (scrollRestore.current) {
      element.scrollTop = scrollRestore.current.top + element.scrollHeight - scrollRestore.current.height;
      scrollRestore.current = null;
      stickToBottom.current = false;
    } else if (stickToBottom.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    }
  }, [messages, typing]);

  useEffect(() => () => clearTimeout(typingTimer.current), []);

  function changeText(value) {
    setText(value);
    if (!socket) return;
    socket.emit("typing:update", { conversationId: conversation.id, isTyping: Boolean(value.trim()) });
    clearTimeout(typingTimer.current);
    if (value.trim()) typingTimer.current = setTimeout(() => socket.emit("typing:update", { conversationId: conversation.id, isTyping: false }), 1600);
  }

  async function loadEarlier() {
    const element = messagesRef.current;
    if (!element || loadingOlder) return;
    scrollRestore.current = { height: element.scrollHeight, top: element.scrollTop };
    const loaded = await onLoadOlder();
    if (!loaded) scrollRestore.current = null;
  }

  async function send(event) {
    event?.preventDefault();
    if ((!text.trim() && !file) || sending) return;
    setSending(true);
    setError("");
    try {
      let attachment;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        attachment = await request("/api/uploads", { method: "POST", body: form });
      }
      if (!socket?.connected) throw new Error("Live connection is unavailable. Try again in a moment.");
      const payload = {
        conversationId: conversation.id,
        content: text.trim(),
        ...(attachment ? { attachmentUrl: attachment.url, attachmentName: attachment.name, attachmentType: attachment.type } : {}),
      };
      await new Promise((resolve, reject) => {
        socket.timeout(7000).emit("message:send", payload, (timeout, response) => {
          if (timeout) return reject(new Error("Message timed out. Please try again."));
          if (response?.error) return reject(new Error(response.error));
          resolve();
        });
      });
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      socket.emit("typing:update", { conversationId: conversation.id, isTyping: false });
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <div className="chat-person">{conversation.type === "GROUP" ? <div className="group-avatar"><Users size={18} /></div> : <Avatar user={other} />}<div><h2>{title}</h2><span>{conversation.type === "GROUP" ? `${conversation.members.length} members${conversation.isPublic ? " · Public" : ""}` : other?.isOnline ? "Active now" : "Conversation"}</span></div></div>
        <div className="header-actions"><span className={`secure-pill ${conversation.isPublic ? "public-pill" : ""}`}>{conversation.isPublic ? <Users size={12} /> : <LockKeyhole size={12} />}{conversation.isPublic ? "PUBLIC ROOM" : "PRIVATE"}</span><div className="relative"><button className="icon-button" onClick={() => setMenu(!menu)} aria-label="Conversation details"><MoreHorizontal size={19} /></button>{menu && <div className="header-menu">{other && <button onClick={() => onReport({ sender: other })}><ShieldAlert size={15} /> Report user</button>}{other && <button className="danger-text" onClick={() => onBlock(other)}><Shield size={15} /> Block user</button>}<span>{conversation.members.map(({ username }) => `@${username}`).join(" · ")}</span></div>}</div></div>
      </header>
      <div className="messages-area" ref={messagesRef} onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
      }}>
        {messages.length === 0 ? <div className="chat-empty"><span className="empty-orbit"><MessageCircle size={24} /></span><h3>This is the beginning.</h3><p>Send a message and let the conversation unfold.</p></div> : <div className="message-stack">{hasMore && <button className="load-earlier" disabled={loadingOlder} onClick={loadEarlier}>{loadingOlder ? "Loading…" : "Load earlier messages"}</button>}{messages.map((message) => <MessageItem key={message.id} message={message} currentUser={user} onEdit={onEdit} onDelete={onDelete} onReport={onReport} />)}</div>}
        {typing && <div className="typing-indicator"><span className="typing-dots"><i /><i /><i /></span>{typing} is typing</div>}
      </div>
      <div className="composer-wrap">
        {file && <div className="pending-file"><FilePlus2 size={15} />{file.name}<button onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}><X size={14} /></button></div>}
        {error && <div className="inline-error">{error}</div>}
        <form className="composer" onSubmit={send}>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <button type="button" className="icon-button attach-button" aria-label="Attach file" onClick={() => fileRef.current?.click()}><Plus size={20} /></button>
          <input value={text} onChange={(e) => changeText(e.target.value)} placeholder="Write a message…" maxLength={4000} aria-label="Message" />
          <span className="composer-hint">↵</span>
          <button className="send-button" disabled={sending || (!text.trim() && !file)} aria-label="Send message">{sending ? <span className="mini-spinner" /> : <Send size={17} />}</button>
        </form>
        <div className="composer-note">{conversation.isPublic ? <Users size={11} /> : <LockKeyhole size={11} />}{conversation.isPublic ? "Messages are visible to everyone in NEXORA PUBLIC GROUP." : "Your conversations are private to your group."}</div>
      </div>
    </section>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [conversations, setConversations] = useState([]);
  const [friendData, setFriendData] = useState({ friends: [], incomingRequests: [], outgoingRequests: [] });
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [socket, setSocket] = useState(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [typing, setTyping] = useState("");
  const [unread, setUnread] = useState({});
  const [online, setOnline] = useState(new Set());
  const [liveConnected, setLiveConnected] = useState(false);
  const [modal, setModal] = useState(null);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [groupMode, setGroupMode] = useState(false);
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [toast, setToast] = useState("");
  const searchRequestId = useRef(0);
  const activeIdRef = useRef(activeId);
  const historyRequestId = useRef(0);
  activeIdRef.current = activeId;

  const active = useMemo(() => conversations.find((item) => item.id === activeId), [conversations, activeId]);
  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3800);
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!user) return;
    try {
      const data = await request("/api/conversations");
      setConversations(data.conversations);
      if (activeIdRef.current && !data.conversations.some((item) => item.id === activeIdRef.current)) {
        activeIdRef.current = null;
        setActiveId(null);
        setMessages([]);
        setHasMore(false);
      }
      setOnline((current) => new Set([...current, ...data.conversations.flatMap((item) => item.members.filter((member) => member.isOnline).map((member) => member.id))]));
    } catch (error) { notify(error.message); }
  }, [user, notify]);

  const refreshFriends = useCallback(async () => {
    if (!user) return;
    try {
      setFriendData(await request("/api/friends"));
    } catch (error) { notify(error.message); }
  }, [user, notify]);

  const loadMessages = useCallback(async (conversationId) => {
    const requestId = ++historyRequestId.current;
    try {
      const data = await request(`/api/conversations/${conversationId}/messages`);
      if (requestId !== historyRequestId.current || activeIdRef.current !== conversationId) return;
      setMessages(data.messages);
      setHasMore(data.messages.length === 50);
      const unreadIds = data.messages.filter((message) => message.senderId !== user.id && !message.reads.some((read) => read.userId === user.id)).map((message) => message.id);
      if (unreadIds.length && socket?.connected) socket.emit("messages:read", { conversationId, messageIds: unreadIds });
      setUnread((old) => ({ ...old, [conversationId]: 0 }));
    } catch (error) { notify(error.message); }
  }, [user, socket, notify]);

  const loadEarlierMessages = useCallback(async () => {
    if (!activeId || !messages.length || loadingOlder || !hasMore) return false;
    const oldest = messages[0];
    setLoadingOlder(true);
    try {
      const cursor = new URLSearchParams({ before: oldest.createdAt, beforeId: oldest.id });
      const result = await request(`/api/conversations/${activeId}/messages?${cursor}`);
      if (activeIdRef.current !== activeId) return false;
      setMessages((items) => [...result.messages, ...items]);
      setHasMore(result.messages.length === 50);
      const unreadIds = result.messages.filter((message) => message.senderId !== user.id && !message.reads.some((read) => read.userId === user.id)).map((message) => message.id);
      if (unreadIds.length && socket?.connected) socket.emit("messages:read", { conversationId: activeId, messageIds: unreadIds });
      return result.messages.length > 0;
    } catch (error) {
      notify(error.message);
      return false;
    } finally {
      setLoadingOlder(false);
    }
  }, [activeId, messages, loadingOlder, hasMore, user, socket, notify]);

  useEffect(() => {
    request("/api/auth/me").then(({ user: current }) => setUser(current)).catch(() => {}).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    refreshConversations();
    refreshFriends();
    const connection = io({ withCredentials: true });
    setSocket(connection);
    connection.on("connect", () => setLiveConnected(true));
    connection.on("disconnect", () => setLiveConnected(false));
    connection.on("connect_error", () => notify("Live connection interrupted. Reconnecting…"));
    connection.on("message:new", (message) => {
      if (message.conversationId === activeIdRef.current) {
        setMessages((items) => items.some((item) => item.id === message.id) ? items : [...items, message]);
        if (message.senderId !== user.id) connection.emit("messages:read", { conversationId: message.conversationId, messageIds: [message.id] });
      } else if (message.senderId !== user.id) {
        setUnread((items) => ({ ...items, [message.conversationId]: (items[message.conversationId] || 0) + 1 }));
        notify(`New message from @${message.sender.username}`);
      }
      refreshConversations();
    });
    connection.on("message:updated", (updated) => setMessages((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item)));
    connection.on("messages:read", ({ conversationId, messageIds, userId: readerId, readAt }) => {
      if (readerId !== user.id) return;
      setMessages((items) => items.map((item) => messageIds.includes(item.id) ? { ...item, reads: [...(item.reads || []).filter((read) => read.userId !== readerId), { userId: readerId, readAt }] } : item));
      if (conversationId === activeIdRef.current) setUnread((items) => ({ ...items, [conversationId]: 0 }));
    });
    connection.on("typing:update", (data) => {
      if (data.conversationId !== activeIdRef.current || data.userId === user.id) return;
      setTyping(data.isTyping ? data.username : "");
      if (data.isTyping) window.setTimeout(() => setTyping((current) => current === data.username ? "" : current), 2200);
    });
    connection.on("presence:update", ({ userId, isOnline }) => {
      setOnline((items) => {
        const next = new Set(items);
        isOnline ? next.add(userId) : next.delete(userId);
        return next;
      });
      refreshConversations();
    });
    connection.on("conversation:created", ({ conversationId }) => {
      connection.emit("conversation:join", { conversationId });
      refreshConversations();
    });
    connection.on("friends:changed", () => {
      refreshFriends();
      refreshConversations();
    });
    connection.on("friend:notification", ({ type, username }) => {
      refreshFriends();
      refreshConversations();
      const messages = {
        request: `@${username} sent you a friend request.`,
        accepted: `@${username} accepted your friend request.`,
        rejected: `@${username} declined your friend request.`,
      };
      if (messages[type]) notify(messages[type]);
    });
    connection.on("profile:updated", (updated) => {
      if (updated.id === user.id) setUser((current) => ({ ...current, ...updated }));
      refreshConversations();
    });
    connection.on("session:expired", () => {
      request("/api/auth/logout", { method: "POST" }).finally(() => setUser(null));
    });
    connection.on("user:banned", ({ userId }) => {
      if (userId === user.id) request("/api/auth/logout", { method: "POST" }).finally(() => setUser(null));
    });
    return () => { connection.disconnect(); setSocket(null); };
  }, [user?.id]);

  useEffect(() => {
    if (activeId && socket?.connected) {
      loadMessages(activeId);
      setTyping("");
    } else if (activeId) loadMessages(activeId);
  }, [activeId, socket, loadMessages]);

  async function selectConversation(conversationId) {
    searchRequestId.current += 1;
    setSearching(false);
    activeIdRef.current = conversationId;
    setActiveId(conversationId);
    setMessages([]);
    setHasMore(false);
    socket?.emit("conversation:join", { conversationId });
    setUnread((items) => ({ ...items, [conversationId]: 0 }));
    setSearch("");
    setSearchResults([]);
    setSearchSubmitted(false);
    setSearchMessage("");
  }

  async function searchUsers(event) {
    event.preventDefault();
    const requestId = ++searchRequestId.current;
    setSearching(false);
    const query = search.trim();
    setSearchSubmitted(true);
    setSearchMessage("");
    setSearchResults([]);
    const valid = groupMode ? query.length > 0 && query.length <= 20 : /^[A-Za-z0-9_]{3,20}$/.test(query);
    if (!valid) {
      setSearchMessage(groupMode ? "Enter a username to find group members." : "Enter an exact username using 3–20 letters, numbers, or underscores.");
      return;
    }
    setSearching(true);
    try {
      const mode = groupMode ? "&mode=group" : "";
      const result = await request(`/api/users/search?q=${encodeURIComponent(query)}${mode}`);
      if (requestId !== searchRequestId.current) return;
      setSearchResults(result.users.map((item) => ({ ...item, isOnline: online.has(item.id) || item.isOnline })));
      if (!result.users.length) setSearchMessage(groupMode ? "No people found yet." : `No account matches @${query}.`);
    } catch (error) {
      if (requestId === searchRequestId.current) setSearchMessage(error.message);
    } finally {
      if (requestId === searchRequestId.current) setSearching(false);
    }
  }

  async function startDirect(target) {
    searchRequestId.current += 1;
    setSearching(false);
    try {
      const result = await request("/api/conversations/direct", { method: "POST", body: { userId: target.id } });
      socket?.emit("conversation:join", { conversationId: result.conversationId });
      await refreshConversations();
      activeIdRef.current = result.conversationId;
      setActiveId(result.conversationId);
      setMessages([]);
      setHasMore(false);
      setSearch("");
      setSearchResults([]);
      setSearchSubmitted(false);
      setSearchMessage("");
    } catch (error) { notify(error.message); }
  }

  async function sendFriendRequest(target) {
    try {
      const result = await request("/api/friends/requests", { method: "POST", body: { userId: target.id } });
      setSearchResults((items) => items.map((item) => item.id === target.id
        ? { ...item, friendStatus: result.status === "ACCEPTED" ? "FRIEND" : "OUTGOING", friendRequestId: result.requestId }
        : item));
      notify(result.status === "ACCEPTED" ? `You and @${target.username} are now friends.` : `Friend request sent to @${target.username}.`);
      await Promise.all([refreshFriends(), refreshConversations()]);
    } catch (error) { notify(error.message); }
  }

  async function acceptFriendRequest(requestId) {
    try {
      await request(`/api/friends/requests/${requestId}/accept`, { method: "POST", body: {} });
      setSearchResults((items) => items.map((item) => item.friendRequestId === requestId ? { ...item, friendStatus: "FRIEND", friendRequestId: null } : item));
      notify("Friend request accepted.");
      await Promise.all([refreshFriends(), refreshConversations()]);
    } catch (error) { notify(error.message); }
  }

  async function rejectFriendRequest(requestId) {
    try {
      await request(`/api/friends/requests/${requestId}/reject`, { method: "POST", body: {} });
      setSearchResults((items) => items.map((item) => item.friendRequestId === requestId ? { ...item, friendStatus: "NONE", friendRequestId: null } : item));
      notify("Friend request declined.");
      await refreshFriends();
    } catch (error) { notify(error.message); }
  }

  async function removeFriend(target) {
    if (!window.confirm(`Remove @${target.username} from your friends? You’ll need to accept a new request before messaging again.`)) return;
    try {
      await request(`/api/friends/${target.id}`, { method: "DELETE" });
      notify(`@${target.username} removed from your friends.`);
      await Promise.all([refreshFriends(), refreshConversations()]);
    } catch (error) { notify(error.message); }
  }

  async function createGroup() {
    if (!groupTitle.trim() || groupMembers.length < 2) return notify("Choose a group name and at least two other members.");
    searchRequestId.current += 1;
    setSearching(false);
    try {
      const result = await request("/api/conversations/group", { method: "POST", body: { title: groupTitle, memberIds: groupMembers.map((item) => item.id) } });
      socket?.emit("conversation:join", { conversationId: result.conversationId });
      await refreshConversations();
      activeIdRef.current = result.conversationId;
      setActiveId(result.conversationId);
      setMessages([]);
      setHasMore(false);
      setGroupMode(false);
      setGroupMembers([]);
      setGroupTitle("");
      setSearch("");
      setSearchResults([]);
      setSearchSubmitted(false);
      setSearchMessage("");
    } catch (error) { notify(error.message); }
  }

  async function editMessage(id, content) {
    try {
      const { message } = await request(`/api/messages/${id}`, { method: "PATCH", body: { content } });
      setMessages((items) => items.map((item) => item.id === id ? { ...item, ...message } : item));
    } catch (error) { notify(error.message); }
  }

  async function deleteMessage(id) {
    if (!window.confirm("Delete this message for everyone in the conversation?")) return;
    try {
      const { message } = await request(`/api/messages/${id}`, { method: "DELETE" });
      setMessages((items) => items.map((item) => item.id === id ? { ...item, ...message } : item));
    } catch (error) { notify(error.message); }
  }

  async function reportUser(target, message) {
    const reason = window.prompt(`Tell us why you are reporting @${target.username}.`);
    if (!reason) return;
    try {
      await request("/api/reports", { method: "POST", body: { userId: target.id, ...(message?.id ? { messageId: message.id } : {}), reason } });
      notify("Report submitted. Our team will review it.");
    } catch (error) { notify(error.message); }
  }

  async function blockUser(target) {
    if (!window.confirm(`Block @${target.username}? They will no longer be able to start or continue a direct conversation with you.`)) return;
    try {
      await request(`/api/users/${target.id}/block`, { method: "POST", body: {} });
      notify(`@${target.username} blocked.`);
      await refreshConversations();
      setActiveId(null);
    } catch (error) { notify(error.message); }
  }

  async function logout() {
    try { await request("/api/auth/logout", { method: "POST" }); }
    catch (error) { notify(error.message); return; }
    setUser(null);
    setConversations([]);
    setFriendData({ friends: [], incomingRequests: [], outgoingRequests: [] });
    setMessages([]);
    setActiveId(null);
    setFriendsOpen(false);
  }

  if (checking) return <div className="loading-screen"><div className="brand-mark"><MessageCircle size={21} /></div><span>NEXORA</span><i /></div>;
  if (!user) return <AuthScreen onAuth={(current) => { setUser(current); setConversations([]); setFriendData({ friends: [], incomingRequests: [], outgoingRequests: [] }); }} />;

  return (
    <main className="app-shell">
      <aside className={`sidebar ${activeId ? "mobile-hidden" : ""}`}>
        <div className="sidebar-top"><div className="brand-lockup"><span className="brand-mark"><MessageCircle size={18} /></span><span>NEXORA</span><small>BETA</small></div><div className="sidebar-top-actions"><button className="icon-button friend-button" title="Friends and requests" aria-label="Friends and requests" onClick={() => setFriendsOpen(true)}><Users size={17} />{friendData.incomingRequests.length > 0 && <i className="friend-count">{friendData.incomingRequests.length}</i>}</button><button className="icon-button" title="New group" onClick={() => { searchRequestId.current += 1; setSearching(false); setGroupMode((mode) => !mode); setSearch(""); setSearchResults([]); setSearchSubmitted(false); setSearchMessage(""); }}><Plus size={19} /></button></div></div>
        <div className="workspace-label"><span>YOUR WORKSPACE</span><button><ChevronDown size={14} /></button></div>
        <form className="search-box" onSubmit={searchUsers}>
          <Search size={16} />
          <input placeholder={groupMode ? "Find group members…" : "Exact username…"} value={search} onChange={(event) => {
            searchRequestId.current += 1;
            setSearching(false);
            setSearch(event.target.value);
            setSearchResults([]);
            setSearchSubmitted(false);
            setSearchMessage("");
          }} aria-label={groupMode ? "Search group members" : "Search exact username"} autoComplete="off" spellCheck="false" />
          <button type="submit" className="search-submit" disabled={searching}>{searching ? "Searching…" : "Search"}</button>
        </form>
        {groupMode && <div className="group-create">
          <div className="group-create-head"><Users size={15} /><strong>New group</strong><button onClick={() => { searchRequestId.current += 1; setSearching(false); setGroupMode(false); setGroupMembers([]); setSearch(""); setSearchResults([]); setSearchSubmitted(false); setSearchMessage(""); }}><X size={14} /></button></div>
          <input className="group-title-input" placeholder="Group name" maxLength={60} value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} />
          {groupMembers.length > 0 && <div className="selected-members">{groupMembers.map((item) => <button key={item.id} onClick={() => setGroupMembers((members) => members.filter((member) => member.id !== item.id))}>@{item.username} <X size={11} /></button>)}</div>}
          <small>Select at least two members from search results.</small>
          <button className="group-create-button" disabled={groupMembers.length < 2 || !groupTitle.trim()} onClick={createGroup}>Create group <ArrowUpRight size={14} /></button>
        </div>}
        {searchResults.length > 0 && <div className="search-results">{searchResults.map((item) => {
          const alreadySelected = groupMembers.some((member) => member.id === item.id);
          const action = groupMode
            ? alreadySelected ? "Added" : "Add to Group"
            : ({
              FRIEND: "Open DM",
              INCOMING: "Accept Request",
              OUTGOING: "Request Sent",
              NONE: "Send Friend Request",
            }[item.friendStatus] || "Send Friend Request");
          return <div key={item.id} className="search-result"><Avatar user={item} size="sm" /><span><strong>@{item.username}</strong><small>{groupMode ? item.isOnline ? "Online · add to group" : "Add to group chat" : item.friendStatus === "FRIEND" ? item.isOnline ? "Friend · online now" : "Accepted friend" : item.friendStatus === "INCOMING" ? "Sent you a friend request" : item.friendStatus === "OUTGOING" ? "Friend request pending" : "Send a request to start chatting"}</small></span><button className="search-result-action" disabled={searching || (groupMode ? alreadySelected : item.friendStatus === "OUTGOING")} onClick={() => {
            if (groupMode) setGroupMembers((members) => members.some((member) => member.id === item.id) ? members : [...members, item]);
            else if (item.friendStatus === "FRIEND") startDirect(item);
            else if (item.friendStatus === "INCOMING") acceptFriendRequest(item.friendRequestId);
            else if (item.friendStatus !== "OUTGOING") sendFriendRequest(item);
          }}>{action}</button></div>;
        })}</div>}
        {searchSubmitted && !searchResults.length && <div className="search-empty">{searchMessage || (groupMode ? "No people found yet." : `No account matches @${search.trim()}.`)}</div>}
        <div className="section-heading"><span>MESSAGES</span><span>{conversations.length}</span></div>
        <div className="conversation-list">
          {conversations.map((conversation) => {
            const person = conversation.displayUser;
            const selected = activeId === conversation.id;
            const title = conversation.type === "GROUP" ? conversation.title : person?.username || "Unavailable user";
            return <button key={conversation.id} className={`conversation-item ${selected ? "active" : ""}`} onClick={() => selectConversation(conversation.id)}>
              {conversation.type === "GROUP" ? <div className="group-avatar small"><Users size={15} /></div> : <Avatar user={{ ...person, isOnline: online.has(person?.id) }} size="md" />}
              <span className="conversation-copy"><strong>{title}</strong><small>{conversation.lastMessage?.attachmentName ? "Shared an attachment" : conversation.lastMessage?.content || "Start a conversation"}</small></span>
              <span className="conversation-meta">{unread[conversation.id] > 0 && <i>{unread[conversation.id]}</i>}<small>{conversation.lastMessage ? new Date(conversation.lastMessage.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</small></span>
            </button>;
          })}
          {conversations.length === 0 && <div className="list-empty"><span><MessageCircle size={18} /></span><p>Your conversations start here.</p><small>Search for someone to say hello.</small></div>}
        </div>
        <div className="sidebar-bottom">
          <div className="account-card"><Avatar user={{ ...user, isOnline: true }} size="md" /><div><strong>{user.username}</strong><small><i /> Online</small></div><div className="account-actions"><button className="icon-button tiny" title="Settings" onClick={() => setModal("profile")}><Settings2 size={16} /></button><button className="icon-button tiny" title="Sign out" onClick={logout}><LogOut size={15} /></button></div></div>
          {user.isAdmin && <button className="admin-link" onClick={() => setModal("admin")}><Shield size={14} /> Admin dashboard <ArrowUpRight size={13} /></button>}
        </div>
      </aside>
      <div className={`main-content ${!activeId ? "no-active" : ""}`}>
        {active ? <><button className="mobile-back" onClick={() => { activeIdRef.current = null; setActiveId(null); }}><ArrowLeft size={17} /> Messages</button><ChatView key={active.id} user={user} conversation={{ ...active, members: active.members.map((member) => ({ ...member, isOnline: online.has(member.id) })) }} messages={messages} typing={typing} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={loadEarlierMessages} onEdit={editMessage} onDelete={deleteMessage} onReport={(message) => reportUser(message.sender, message)} onBlock={blockUser} socket={socket} /></> : <div className="welcome-panel"><div className="welcome-art"><span className="art-ring ring-one" /><span className="art-ring ring-two" /><span className="art-center"><MessageCircle size={27} /></span><span className="art-star star-one">✦</span><span className="art-star star-two">✧</span></div><span className="eyebrow">GOOD TO SEE YOU, {user.username.toUpperCase()}</span><h1>Your people,<br /><em>closer than ever.</em></h1><p>Pick a conversation or find someone new to talk to.</p><button className="welcome-button" onClick={() => document.querySelector(".search-box input")?.focus()}><Search size={15} /> Find someone <span>⌘ K</span></button><div className="welcome-foot"><span><LockKeyhole size={12} /> PRIVATE BY DESIGN</span><span>MAKE SPACE FOR WHAT MATTERS <ArrowDownLeft size={12} /></span></div></div>}
      </div>
      <div className={`connection-indicator ${liveConnected ? "" : "disconnected"}`}><span /> {liveConnected ? "LIVE" : "RECONNECTING"}</div>
      {modal === "profile" && <ProfileModal user={user} close={() => setModal(null)} onSaved={(updated) => { setUser(updated); notify("Profile updated."); }} socket={socket} />}
      {modal === "admin" && <AdminPanel close={() => setModal(null)} notify={notify} />}
      {friendsOpen && <FriendsPanel friends={friendData.friends} incomingRequests={friendData.incomingRequests} outgoingRequests={friendData.outgoingRequests} close={() => setFriendsOpen(false)} onAccept={acceptFriendRequest} onReject={rejectFriendRequest} onRemove={removeFriend} onChat={startDirect} />}
      {toast && <div className="toast"><CircleHelp size={16} /> {toast}<button onClick={() => setToast("")}><X size={14} /></button></div>}
    </main>
  );
}
