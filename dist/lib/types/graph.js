"use strict";
/**
 * Graph System Type Definitions
 *
 * Defines the structure for storing and compiling graph configurations.
 * All nodes are universal nodes — the graph compiler routes every node
 * through the same universalNode function, which loads its config from
 * the `nodes` collection in MongoDB by `config.nodeId`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_TEMPLATES = void 0;
exports.isSystemTemplate = isSystemTemplate;
/**
 * System default graph IDs (Phase 2: Dynamic Graph System)
 * Default graphs are stored with userId: 'system' and isDefault: true in MongoDB
 * These constants provide convenient access to system default graph IDs
 */
exports.SYSTEM_TEMPLATES = {
    SIMPLE: 'red-chat',
    DEFAULT: 'red-assistant',
    // Future system graphs:
    // RESEARCH: 'research-assistant',
    // AUTOMATION: 'automation-agent',
    // ENTERPRISE: 'enterprise-workflow'
};
/**
 * Type guard to check if a string is a valid system template ID
 */
function isSystemTemplate(value) {
    return Object.values(exports.SYSTEM_TEMPLATES).includes(value);
}
