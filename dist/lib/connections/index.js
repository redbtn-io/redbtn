"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTokenExpiring = exports.resolveCredentials = exports.buildAuthHeaders = exports.decryptCredentials = exports.ConnectionManager = void 0;
/**
 * Connections Module
 *
 * Runtime utilities for managing and using user connections in graph execution.
 */
var ConnectionManager_1 = require("./ConnectionManager");
Object.defineProperty(exports, "ConnectionManager", { enumerable: true, get: function () { return ConnectionManager_1.ConnectionManager; } });
Object.defineProperty(exports, "decryptCredentials", { enumerable: true, get: function () { return ConnectionManager_1.decryptCredentials; } });
Object.defineProperty(exports, "buildAuthHeaders", { enumerable: true, get: function () { return ConnectionManager_1.buildAuthHeaders; } });
Object.defineProperty(exports, "resolveCredentials", { enumerable: true, get: function () { return ConnectionManager_1.resolveCredentials; } });
Object.defineProperty(exports, "isTokenExpiring", { enumerable: true, get: function () { return ConnectionManager_1.isTokenExpiring; } });
