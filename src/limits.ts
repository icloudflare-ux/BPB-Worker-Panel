const ACTIVE_SESSIONS_KEY = 'active-sessions';
const USAGE_BYTES_KEY = 'usage-bytes';
const LAST_RESET_KEY = 'last-reset';
const SESSION_HISTORY_KEY = 'session-history';

interface SessionGuard {
    allow: boolean;
    reason?: string;
    commitInboundBytes(bytes: number): Promise<void>;
    commitOutboundBytes(bytes: number): Promise<void>;
    close(): Promise<void>;
}

export async function createSessionGuard(): Promise<SessionGuard> {
    const {
        settings: { configMaxUsers, configDurationDays, configVolumeGB },
        globalConfig: { kv, userID },
        wsConfig: { profile, profileUsersLimit, profileDurationDays, profileVolumeGB }
    } = globalThis;

    const now = Date.now();
    const keyPrefix = profile ? `limits:profile:${profile}:` : 'limits:';
    const maxUsersLimit = profileUsersLimit && profileUsersLimit > 0 ? profileUsersLimit : configMaxUsers;
    const durationDaysLimit = profileDurationDays !== undefined ? profileDurationDays : configDurationDays;
    const volumeGbLimit = profileVolumeGB !== undefined ? profileVolumeGB : configVolumeGB;

    const createdAt = await getOrInitCreatedAt(kv, keyPrefix + LAST_RESET_KEY, now);
    const expireAt = durationDaysLimit > 0 ? createdAt + (durationDaysLimit * 24 * 60 * 60 * 1000) : 0;

    if (expireAt > 0 && now >= expireAt) {
        return deny('Configuration expired.');
    }

    const totalBytesLimit = volumeGbLimit > 0
        ? Math.floor(volumeGbLimit * 1024 * 1024 * 1024)
        : 0;

    const currentUsage = await getNumber(kv, keyPrefix + USAGE_BYTES_KEY);
    if (totalBytesLimit > 0 && currentUsage >= totalBytesLimit) {
        return deny('Volume limit reached.');
    }

    const activeSessions = await getNumber(kv, keyPrefix + ACTIVE_SESSIONS_KEY);
    if (maxUsersLimit > 0 && activeSessions >= maxUsersLimit) {
        return deny('Maximum simultaneous users reached.');
    }

    await kv.put(keyPrefix + ACTIVE_SESSIONS_KEY, String(activeSessions + 1));

    const sessionId = crypto.randomUUID();
    await appendSessionHistory(kv, keyPrefix + SESSION_HISTORY_KEY, {
        timestamp: now,
        type: 'start',
        userID,
        profile: profile || 'default',
        sessionId,
        activeSessions: activeSessions + 1
    });

    let isClosed = false;
    let bufferedBytes = 0;
    let sessionBytes = 0;

    const flushUsage = async () => {
        if (!bufferedBytes) return;

        const latestUsage = await getNumber(kv, keyPrefix + USAGE_BYTES_KEY);
        await kv.put(keyPrefix + USAGE_BYTES_KEY, String(latestUsage + bufferedBytes));

        const day = new Date().toISOString().slice(0, 10);
        const dailyKey = `${keyPrefix}daily:${day}`;
        const dailyUsage = await getNumber(kv, dailyKey);
        await kv.put(dailyKey, String(dailyUsage + bufferedBytes));

        bufferedBytes = 0;
    };

    const addBytes = async (bytes: number) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return;

        bufferedBytes += bytes;
        sessionBytes += bytes;
        if (bufferedBytes >= 64 * 1024) {
            await flushUsage();
        }

        if (totalBytesLimit > 0) {
            const latestUsage = await getNumber(kv, keyPrefix + USAGE_BYTES_KEY);
            if (latestUsage + bufferedBytes > totalBytesLimit) {
                throw new Error('Volume limit reached.');
            }
        }
    };

    return {
        allow: true,
        async commitInboundBytes(bytes: number) {
            await addBytes(bytes);
        },
        async commitOutboundBytes(bytes: number) {
            await addBytes(bytes);
        },
        async close() {
            if (isClosed) return;
            isClosed = true;

            await flushUsage();
            const latestActive = await getNumber(kv, keyPrefix + ACTIVE_SESSIONS_KEY);
            const finalActive = Math.max(latestActive - 1, 0);
            await kv.put(keyPrefix + ACTIVE_SESSIONS_KEY, String(finalActive));

            await appendSessionHistory(kv, keyPrefix + SESSION_HISTORY_KEY, {
                timestamp: Date.now(),
                type: 'end',
                userID,
                profile: profile || 'default',
                sessionId,
                bytes: sessionBytes,
                durationSec: Math.max(1, Math.floor((Date.now() - now) / 1000)),
                activeSessions: finalActive
            });
        }
    };

    function deny(reason: string): SessionGuard {
        return {
            allow: false,
            reason,
            async commitInboundBytes() { },
            async commitOutboundBytes() { },
            async close() { }
        };
    }
}

async function getOrInitCreatedAt(kv: KVNamespace, key: string, now: number) {
    const raw = await kv.get(key);
    if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    await kv.put(key, String(now));
    return now;
}

async function getNumber(kv: KVNamespace, key: string) {
    const value = await kv.get(key);
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function appendSessionHistory(kv: KVNamespace, key: string, entry: Record<string, any>) {
    const historyRaw = await kv.get(key);
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    history.unshift(entry);
    await kv.put(key, JSON.stringify(history.slice(0, 50)));
}
