'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PresenceAvatars, TriageUser } from './PresenceAvatars';
import { getSocket } from '@/lib/socket';

export type IncidentStatus = 'Unassigned' | 'Investigating' | 'Resolved' | 'False Positive';
export type IncidentSeverity = 'info' | 'warning' | 'critical';

export interface TriageComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  parentId?: string | null;
  replies?: TriageComment[];
}

export interface IncidentAlert {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  claimedBy?: {
    id: string;
    name: string;
    claimedAt: string;
  } | null;
  txHash: string;
  amount: number | string;
  asset: string;
  fromAddress: string;
  destinationAddress?: string;
  memo?: string;
  timestamp: string;
  riskScore?: number;
  tags?: string[];
  comments: TriageComment[];
}

export interface AlertTriageWorkspaceProps {
  initialIncident?: IncidentAlert;
  incidentId?: string;
  currentUser?: {
    id: string;
    name: string;
    email?: string;
  };
}

const DEFAULT_INCIDENT: IncidentAlert = {
  id: 'INC-84920',
  title: 'Anomalous High-Frequency Withdrawal Spurt',
  severity: 'critical',
  status: 'Investigating',
  claimedBy: {
    id: 'user-alice',
    name: 'Alice Vance',
    claimedAt: new Date(Date.now() - 15 * 60000).toISOString(),
  },
  txHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  amount: 450000,
  asset: 'USDC',
  fromAddress: 'GA5ZSEJYB37JKN5AASRCLWFSLGLWXA2P192837LPLMNBVCAXZ',
  destinationAddress: 'GB7BVI24E5L2CVT4N3S46A8B9OPX1234567890STUVWXYZ',
  memo: 'Bridge liquidation drain',
  timestamp: new Date().toISOString(),
  riskScore: 94,
  tags: ['High Velocity', 'Large Cap Outflow', 'New Recipient'],
  comments: [
    {
      id: 'comm-1',
      authorId: 'user-alice',
      authorName: 'Alice Vance',
      content: 'Flagged transaction for immediate review. Velocity spiked 400% above historical baseline.',
      createdAt: new Date(Date.now() - 12 * 60000).toISOString(),
      parentId: null,
      replies: [
        {
          id: 'comm-2',
          authorId: 'user-bob',
          authorName: 'Bob Chen',
          content: 'Confirmed destination address was created 3 hours ago on Testnet/Pubnet.',
          createdAt: new Date(Date.now() - 8 * 60000).toISOString(),
          parentId: 'comm-1',
        },
      ],
    },
  ],
};

const STATUS_OPTIONS: { status: IncidentStatus; label: string; badgeClass: string }[] = [
  {
    status: 'Unassigned',
    label: 'Unassigned',
    badgeClass: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  },
  {
    status: 'Investigating',
    label: 'Investigating',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.2)]',
  },
  {
    status: 'Resolved',
    label: 'Resolved',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  },
  {
    status: 'False Positive',
    label: 'False Positive',
    badgeClass: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  },
];

export const AlertTriageWorkspace: React.FC<AlertTriageWorkspaceProps> = ({
  initialIncident,
  incidentId,
  currentUser = { id: 'user-curr', name: 'Zion Operator', email: 'operator@stellar.org' },
}) => {
  const [incident, setIncident] = useState<IncidentAlert>(() => {
    if (initialIncident) return initialIncident;
    if (incidentId) return { ...DEFAULT_INCIDENT, id: incidentId };
    return DEFAULT_INCIDENT;
  });

  // Live presence state
  const [activeUsers, setActiveUsers] = useState<TriageUser[]>([
    {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      color: 'bg-cyan-500',
      isCurrentUser: true,
      lastActive: Date.now(),
    },
    {
      id: 'user-alice',
      name: 'Alice Vance',
      email: 'alice@stellar.org',
      color: 'bg-purple-500',
      lastActive: Date.now() - 5000,
    },
    {
      id: 'user-bob',
      name: 'Bob Chen',
      email: 'bob@stellar.org',
      color: 'bg-emerald-500',
      lastActive: Date.now() - 12000,
    },
  ]);

  // Comment input state
  const [newCommentText, setNewCommentText] = useState('');
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  // Channel reference for instantaneous inter-tab/browser broadcast
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Synchronize status updates
  const handleStatusChange = (newStatus: IncidentStatus) => {
    const updated = { ...incident, status: newStatus };
    setIncident(updated);

    // Broadcast update across connected browsers
    broadcastMessage({
      type: 'STATUS_UPDATE',
      incidentId: incident.id,
      status: newStatus,
      updatedBy: currentUser,
      timestamp: Date.now(),
    });
  };

  // Claim or release incident
  const handleClaimToggle = () => {
    const isClaimedByMe = incident.claimedBy?.id === currentUser.id;

    const updatedClaim = isClaimedByMe
      ? null
      : {
          id: currentUser.id,
          name: currentUser.name,
          claimedAt: new Date().toISOString(),
        };

    const newStatus: IncidentStatus = isClaimedByMe ? 'Unassigned' : 'Investigating';

    const updated: IncidentAlert = {
      ...incident,
      claimedBy: updatedClaim,
      status: newStatus,
    };
    setIncident(updated);

    broadcastMessage({
      type: 'CLAIM_UPDATE',
      incidentId: incident.id,
      claimedBy: updatedClaim,
      status: newStatus,
      updatedBy: currentUser,
      timestamp: Date.now(),
    });
  };

  // Post top-level comment
  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentText.trim()) return;

    const newComment: TriageComment = {
      id: `comm-${Date.now()}`,
      authorId: currentUser.id,
      authorName: currentUser.name,
      content: newCommentText.trim(),
      createdAt: new Date().toISOString(),
      parentId: null,
      replies: [],
    };

    setIncident((prev) => ({
      ...prev,
      comments: [newComment, ...prev.comments],
    }));

    setNewCommentText('');

    broadcastMessage({
      type: 'NEW_COMMENT',
      incidentId: incident.id,
      comment: newComment,
      timestamp: Date.now(),
    });
  };

  // Post threaded reply
  const handleAddReply = (parentId: string) => {
    if (!replyText.trim()) return;

    const reply: TriageComment = {
      id: `reply-${Date.now()}`,
      authorId: currentUser.id,
      authorName: currentUser.name,
      content: replyText.trim(),
      createdAt: new Date().toISOString(),
      parentId,
    };

    setIncident((prev) => ({
      ...prev,
      comments: prev.comments.map((c) => {
        if (c.id === parentId) {
          return {
            ...c,
            replies: [...(c.replies || []), reply],
          };
        }
        return c;
      }),
    }));

    setReplyingToId(null);
    setReplyText('');

    broadcastMessage({
      type: 'NEW_REPLY',
      incidentId: incident.id,
      parentId,
      reply,
      timestamp: Date.now(),
    });
  };

  // Broadcast helper using BroadcastChannel & WebSocket
  const broadcastMessage = useCallback((payload: any) => {
    try {
      if (channelRef.current) {
        channelRef.current.postMessage(payload);
      }
      const socket = getSocket();
      if (socket && socket.isConnected) {
        socket.send(payload);
      }
    } catch (err) {
      console.warn('[AlertTriageWorkspace] Broadcast failed:', err);
    }
  }, []);

  // Setup presence & broadcast listeners
  useEffect(() => {
    const channelName = `stellar-incident-triage-${incident.id}`;
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      const channel = new BroadcastChannel(channelName);
      channelRef.current = channel;

      channel.onmessage = (event) => {
        const msg = event.data;
        if (!msg || msg.incidentId !== incident.id) return;

        if (msg.type === 'STATUS_UPDATE') {
          setIncident((prev) => ({ ...prev, status: msg.status }));
        } else if (msg.type === 'CLAIM_UPDATE') {
          setIncident((prev) => ({
            ...prev,
            claimedBy: msg.claimedBy,
            status: msg.status,
          }));
        } else if (msg.type === 'NEW_COMMENT') {
          setIncident((prev) => ({
            ...prev,
            comments: [msg.comment, ...prev.comments.filter((c) => c.id !== msg.comment.id)],
          }));
        } else if (msg.type === 'NEW_REPLY') {
          setIncident((prev) => ({
            ...prev,
            comments: prev.comments.map((c) =>
              c.id === msg.parentId
                ? {
                    ...c,
                    replies: [...(c.replies || []).filter((r) => r.id !== msg.reply.id), msg.reply],
                  }
                : c
            ),
          }));
        } else if (msg.type === 'PRESENCE_HEARTBEAT') {
          setActiveUsers((prev) => {
            const existingIdx = prev.findIndex((u) => u.id === msg.user.id);
            if (existingIdx >= 0) {
              const updated = [...prev];
              updated[existingIdx] = { ...msg.user, lastActive: Date.now() };
              return updated;
            }
            return [...prev, { ...msg.user, lastActive: Date.now() }];
          });
        }
      };

      // Announce current user presence
      channel.postMessage({
        type: 'PRESENCE_HEARTBEAT',
        incidentId: incident.id,
        user: {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email,
          color: 'bg-cyan-500',
        },
      });
    }

    return () => {
      if (channelRef.current) {
        channelRef.current.close();
      }
    };
  }, [incident.id, currentUser]);

  const isClaimedByMe = incident.claimedBy?.id === currentUser.id;

  return (
    <div
      data-testid="alert-triage-workspace"
      className="space-y-6 max-w-7xl mx-auto"
    >
      {/* Top Workspace Header */}
      <div className="bg-[#0b0c16] border border-white/10 rounded-3xl p-6 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold text-cyan-400 bg-cyan-950/50 border border-cyan-500/30 px-2 py-0.5 rounded-lg">
                {incident.id}
              </span>
              <span className="text-xs font-bold uppercase tracking-wider text-red-400 bg-red-950/40 border border-red-500/30 px-2 py-0.5 rounded-lg">
                {incident.severity}
              </span>
            </div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight">
              {incident.title}
            </h1>
          </div>

          {/* Right Action Cluster: Live Presence & Claim Badge */}
          <div className="flex flex-wrap items-center gap-3">
            <PresenceAvatars users={activeUsers} currentUserId={currentUser.id} />

            {/* Claim Ownership Button & Badge */}
            <div className="flex items-center gap-2">
              {incident.claimedBy ? (
                <div
                  data-testid="claim-badge"
                  className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-purple-950/40 border border-purple-500/40 text-xs text-purple-200"
                >
                  <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                  <span>
                    Investigating by{' '}
                    <strong className="text-white font-semibold">
                      {isClaimedByMe ? 'You' : incident.claimedBy.name}
                    </strong>
                  </span>
                </div>
              ) : (
                <div
                  data-testid="claim-badge"
                  className="px-3 py-1.5 rounded-xl bg-gray-800/60 border border-white/10 text-xs text-gray-400"
                >
                  Unclaimed
                </div>
              )}

              <button
                type="button"
                onClick={handleClaimToggle}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  isClaimedByMe
                    ? 'bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300'
                    : 'bg-cyan-500 hover:bg-cyan-400 text-black font-extrabold shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                }`}
              >
                {isClaimedByMe ? 'Release Claim' : 'Claim Alert'}
              </button>
            </div>
          </div>
        </div>

        {/* Status Assignment Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-gray-400 mr-1">
              Incident Status:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map((opt) => {
                const isActive = incident.status === opt.status;
                return (
                  <button
                    key={opt.status}
                    type="button"
                    onClick={() => handleStatusChange(opt.status)}
                    className={`px-3 py-1 rounded-xl text-xs font-bold transition-all border cursor-pointer ${
                      isActive
                        ? opt.badgeClass
                        : 'bg-[#090b14] border-white/5 text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="text-xs text-gray-500 font-mono">
            Reported: {new Date(incident.timestamp).toLocaleString()}
          </div>
        </div>
      </div>

      {/* Main Workspace Body: Left (Details) + Right (Threaded Comments) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Transaction & Security Details (7 Cols) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Transaction Metadata Card */}
          <div className="bg-[#0b0c16] border border-white/10 rounded-3xl p-6 space-y-5 shadow-xl">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">
              Transaction Investigation Data
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-3.5 rounded-2xl bg-[#07080e] border border-white/5 space-y-1">
                <span className="text-[11px] uppercase tracking-wider text-gray-500">
                  Amount Transferred
                </span>
                <div className="text-xl font-mono font-bold text-cyan-300">
                  {typeof incident.amount === 'number'
                    ? incident.amount.toLocaleString()
                    : incident.amount}{' '}
                  {incident.asset}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-[#07080e] border border-white/5 space-y-1">
                <span className="text-[11px] uppercase tracking-wider text-gray-500">
                  Risk Assessment Score
                </span>
                <div className="text-xl font-mono font-bold text-red-400 flex items-center gap-2">
                  <span>{incident.riskScore || 85} / 100</span>
                  <span className="text-xs text-red-300 px-2 py-0.5 rounded-md bg-red-500/20">
                    High Risk
                  </span>
                </div>
              </div>
            </div>

            {/* Address Details */}
            <div className="space-y-3 text-xs font-mono">
              <div>
                <span className="text-gray-400 block mb-1">Transaction Hash:</span>
                <div className="p-2.5 rounded-xl bg-[#07080e] border border-white/5 text-cyan-300 break-all select-all">
                  {incident.txHash}
                </div>
              </div>

              <div>
                <span className="text-gray-400 block mb-1">Origin Public Key (Sender):</span>
                <div className="p-2.5 rounded-xl bg-[#07080e] border border-white/5 text-gray-300 break-all select-all">
                  {incident.fromAddress}
                </div>
              </div>

              {incident.destinationAddress && (
                <div>
                  <span className="text-gray-400 block mb-1">Destination Address:</span>
                  <div className="p-2.5 rounded-xl bg-[#07080e] border border-white/5 text-gray-300 break-all select-all">
                    {incident.destinationAddress}
                  </div>
                </div>
              )}

              {incident.memo && (
                <div>
                  <span className="text-gray-400 block mb-1">Transaction Memo:</span>
                  <div className="p-2.5 rounded-xl bg-[#07080e] border border-white/5 text-amber-200">
                    "{incident.memo}"
                  </div>
                </div>
              )}
            </div>

            {/* Tags */}
            {incident.tags && incident.tags.length > 0 && (
              <div className="pt-2">
                <span className="text-[11px] uppercase tracking-wider text-gray-500 block mb-2">
                  Security Flags & Indicators
                </span>
                <div className="flex flex-wrap gap-2">
                  {incident.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2.5 py-1 rounded-lg bg-red-950/30 border border-red-500/30 text-red-300 text-xs font-semibold"
                    >
                      ⚠️ {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Real-Time Collaborative Annotation Threads (5 Cols) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-[#0b0c16] border border-white/10 rounded-3xl p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <span>💬</span>
                Threaded Triage Notes
              </h2>
              <span className="text-xs text-gray-400 font-mono">
                {incident.comments.length} notes
              </span>
            </div>

            {/* New Comment Input */}
            <form onSubmit={handleAddComment} className="space-y-2">
              <textarea
                rows={3}
                placeholder="Add investigation note or mention team members..."
                value={newCommentText}
                onChange={(e) => setNewCommentText(e.target.value)}
                className="w-full p-3 rounded-2xl bg-[#07080e] border border-white/10 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-cyan-400 resize-none"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!newCommentText.trim()}
                  className="px-4 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-extrabold text-xs transition-all cursor-pointer disabled:opacity-50"
                >
                  Post Note
                </button>
              </div>
            </form>

            {/* Comments & Replies List */}
            <div className="space-y-4 max-h-[500px] overflow-y-auto pr-1">
              {incident.comments.map((comment) => (
                <div
                  key={comment.id}
                  data-testid={`comment-${comment.id}`}
                  className="p-4 rounded-2xl bg-[#0e101c] border border-white/5 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-cyan-600 text-white flex items-center justify-center text-[10px] font-bold">
                        {comment.authorName[0]}
                      </div>
                      <span className="text-xs font-bold text-white">{comment.authorName}</span>
                    </div>
                    <span className="text-[10px] text-gray-500">
                      {new Date(comment.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  <p className="text-xs text-gray-300 leading-relaxed">{comment.content}</p>

                  {/* Threaded Replies */}
                  {comment.replies && comment.replies.length > 0 && (
                    <div className="ml-4 pl-3 border-l-2 border-white/10 space-y-2 pt-2">
                      {comment.replies.map((reply) => (
                        <div key={reply.id} className="text-xs space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-purple-300">
                              {reply.authorName}
                            </span>
                            <span className="text-[10px] text-gray-500">
                              {new Date(reply.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                          <p className="text-gray-300">{reply.content}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reply Button or Input */}
                  <div className="pt-1">
                    {replyingToId === comment.id ? (
                      <div className="space-y-2 mt-2">
                        <input
                          type="text"
                          placeholder="Write a reply..."
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-xl bg-[#07080e] border border-white/10 text-xs text-white focus:outline-none focus:border-cyan-400"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setReplyingToId(null);
                              setReplyText('');
                            }}
                            className="text-xs text-gray-400 hover:text-white px-2 py-1 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddReply(comment.id)}
                            className="px-3 py-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-bold cursor-pointer"
                          >
                            Reply
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setReplyingToId(comment.id)}
                        className="text-[11px] font-semibold text-cyan-400 hover:underline cursor-pointer"
                      >
                        Reply to thread
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
