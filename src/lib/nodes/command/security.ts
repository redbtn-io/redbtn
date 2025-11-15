/**
 * Command security validator
 * Prevents execution of dangerous commands
 */

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Patterns of dangerous commands that should be blocked
 */
const DANGEROUS_PATTERNS = [
  // Destructive filesystem operations
  /rm\s+(-[rf]+\s+)?\/\s*$/i,           // rm -rf /
  /rm\s+-rf\s+\/[^/\s]*/i,               // rm -rf /anything
  /:\(\)\{\s*:\|\:&\s*\};:/,             // Fork bomb
  /mkfs/i,                                 // Format filesystem
  /dd\s+if=/i,                            // Direct disk access
  
  // Privilege escalation
  /sudo\s+rm/i,
  /sudo\s+dd/i,
  /sudo\s+mkfs/i,
  
  // System shutdown/reboot
  /shutdown/i,
  /reboot/i,
  /halt/i,
  /poweroff/i,
  
  // Package manager uninstalls (too risky)
  /apt\s+(-[a-z]+\s+)?(remove|purge|autoremove)/i,
  /yum\s+remove/i,
  /dnf\s+remove/i,
  
  // Modify system files
  />\s*\/etc\//,
  />\s*\/bin\//,
  />\s*\/sbin\//,
  />\s*\/usr\/bin\//,
  />\s*\/usr\/sbin\//,
];

/**
 * Validate a command for security
 * Throws SecurityError if command is dangerous
 */
export function validateCommand(command: string): void {
  // Check against dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      throw new SecurityError(
        `Command blocked for security: matches dangerous pattern "${pattern.source}"`
      );
    }
  }

  // Additional checks for suspicious keywords
  const lowerCommand = command.toLowerCase();
  
  if (lowerCommand.includes('rm -rf /')) {
    throw new SecurityError('Command blocked: attempting to delete root filesystem');
  }
  
  if (lowerCommand.includes(':(){ :|:& };:')) {
    throw new SecurityError('Command blocked: fork bomb detected');
  }
}
