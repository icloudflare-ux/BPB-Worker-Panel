const ACTIVE_SESSIONS_KEY = 'limits:active-sessions';
const USAGE_BYTES_KEY = 'limits:usage-bytes';
const LAST_RESET_KEY = 'limits:last-reset';

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
        globalConfig: { kv }
    } = globalThis;

    const now = Date.now();
    const createdAt = await getOrInitCreatedAt(kv, now);
    const expireAt = configDurationDays > 0 ? createdAt + (configDurationDays * 24 * 60 * 60 * 1000) : 0;

    if (expireAt > 0 && now >= expireAt) {
        return deny('Configuration expired.');
    }

    const totalBytesLimit = configVolumeGB > 0
        ? Math.floor(configVolumeGB * 1024 * 1024 * 1024)
        : 0;

    const currentUsage = await getNumber(kv, USAGE_BYTES_KEY);
    if (totalBytesLimit > 0 && currentUsage >= totalBytesLimit) {
        return deny('Volume limit reached.');
    }

    const activeSessions = await getNumber(kv, ACTIVE_SESSIONS_KEY);
    if (configMaxUsers > 0 && activeSessions >= configMaxUsers) {
        return deny('Maximum simultaneous users reached.');
    }

    await kv.put(ACTIVE_SESSIONS_KEY, String(activeSessions + 1));

    let isClosed = false;
    let bufferedBytes = 0;

    const flushUsage = async () => {
        if (!bufferedBytes) return;

        const latestUsage = await getNumber(kv, USAGE_BYTES_KEY);
        await kv.put(USAGE_BYTES_KEY, String(latestUsage + bufferedBytes));
        bufferedBytes = 0;
    };

    const addBytes = async (bytes: number) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return;

        bufferedBytes += bytes;
        const shouldFlush = bufferedBytes >= 64 * 1024;

        if (shouldFlush) {
            await flushUsage();
        }

        if (totalBytesLimit > 0) {
            const latestUsage = await getNumber(kv, USAGE_BYTES_KEY);
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
            const latestActive = await getNumber(kv, ACTIVE_SESSIONS_KEY);
            await kv.put(ACTIVE_SESSIONS_KEY, String(Math.max(latestActive - 1, 0)));
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

async function getOrInitCreatedAt(kv: KVNamespace, now: number) {
    const raw = await kv.get(LAST_RESET_KEY);

    if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    await kv.put(LAST_RESET_KEY, String(now));
    return now;
}

async function getNumber(kv: KVNamespace, key: string) {
    const value = await kv.get(key);
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}
