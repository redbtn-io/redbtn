"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunLock = void 0;
exports.createRunLock = createRunLock;
exports.acquireRunLock = acquireRunLock;
exports.isConversationLocked = isConversationLocked;
exports.isGraphLocked = isGraphLocked;
const types_1 = require("./types");
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
const RENEW_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;
function generateToken() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}
class RunLock {
    constructor(redis) {
        this.redis = redis;
    }
    acquire(conversationId, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const key = types_1.RunKeys.lock(conversationId);
            const token = generateToken();
            const ttl = (_a = options === null || options === void 0 ? void 0 : options.ttlSeconds) !== null && _a !== void 0 ? _a : types_1.RunConfig.LOCK_TTL_SECONDS;
            const result = yield this.redis.set(key, token, 'EX', ttl, 'NX');
            if (result !== 'OK')
                return null;
            let renewalTimer = null;
            const stopRenewal = () => {
                if (renewalTimer) {
                    clearInterval(renewalTimer);
                    renewalTimer = null;
                }
            };
            if ((options === null || options === void 0 ? void 0 : options.autoRenew) !== false) {
                const renewalInterval = (_b = options === null || options === void 0 ? void 0 : options.renewalIntervalMs) !== null && _b !== void 0 ? _b : types_1.RunConfig.LOCK_RENEWAL_INTERVAL_MS;
                renewalTimer = setInterval(() => __awaiter(this, void 0, void 0, function* () {
                    try {
                        const renewed = yield this.renew(conversationId, token, ttl);
                        if (!renewed)
                            stopRenewal();
                    }
                    catch (error) {
                        console.error('Lock renewal failed:', error);
                        stopRenewal();
                    }
                }), renewalInterval);
            }
            const release = () => __awaiter(this, void 0, void 0, function* () {
                stopRenewal();
                return this.release(conversationId, token);
            });
            return { token, conversationId, release, stopRenewal };
        });
    }
    release(conversationId, token) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = types_1.RunKeys.lock(conversationId);
            const result = yield this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
            return result === 1;
        });
    }
    renew(conversationId, token, ttlSeconds) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = types_1.RunKeys.lock(conversationId);
            const ttl = ttlSeconds !== null && ttlSeconds !== void 0 ? ttlSeconds : types_1.RunConfig.LOCK_TTL_SECONDS;
            const result = yield this.redis.eval(RENEW_LOCK_SCRIPT, 1, key, token, ttl.toString());
            return result === 1;
        });
    }
    isLocked(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = types_1.RunKeys.lock(conversationId);
            const value = yield this.redis.get(key);
            return value !== null;
        });
    }
    getLockInfo(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = types_1.RunKeys.lock(conversationId);
            const [token, ttl] = yield Promise.all([this.redis.get(key), this.redis.ttl(key)]);
            if (!token || ttl < 0)
                return null;
            return { token, ttl };
        });
    }
    forceRelease(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = types_1.RunKeys.lock(conversationId);
            const result = yield this.redis.del(key);
            return result === 1;
        });
    }
}
exports.RunLock = RunLock;
function createRunLock(redis) {
    return new RunLock(redis);
}
function acquireRunLock(redis, conversationId, options) {
    return __awaiter(this, void 0, void 0, function* () {
        const lock = new RunLock(redis);
        return lock.acquire(conversationId, options);
    });
}
function isConversationLocked(redis, conversationId) {
    return __awaiter(this, void 0, void 0, function* () {
        const lock = new RunLock(redis);
        return lock.isLocked(conversationId);
    });
}
/** @deprecated Use isConversationLocked instead */
function isGraphLocked(_redis, _userId, _graphId) {
    return __awaiter(this, void 0, void 0, function* () {
        console.warn('[RunLock] isGraphLocked is deprecated, use isConversationLocked instead');
        return false;
    });
}
