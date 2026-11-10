/**
 * browser-types — wire types for the browser native tools (redbtn browser extension)
 *
 * Light module: no heavy imports, safe to import from anywhere (including
 * tests) without pulling in Redis / Mongo / the environment stack.
 *
 * Wire contract (fixed — other lanes build to it): a browser call dispatches
 * requestDesktopRaw({ kind: 'browser', payload: { request: BrowserAction } })
 * and the extension replies { ok, result?, image?, error?: { code, message } }.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface BrowserActionBase {
  runId?: string;
  agentName?: string;
  // Pragmatic passthrough for forward-compatible args the extension may add.
  [key: string]: unknown;
}

export type BrowserAction =
  | (BrowserActionBase & {
      action: 'tabs';
      op?: 'list' | 'open' | 'close' | 'activate' | string;
      tabId?: number;
      url?: string;
      waitMs?: number;
    })
  | (BrowserActionBase & { action: 'snapshot'; tabId?: number })
  | (BrowserActionBase & { action: 'read'; tabId?: number; format?: 'text' | 'markdown' | string })
  | (BrowserActionBase & {
      action: 'screenshot';
      tabId?: number;
      format?: 'png' | 'jpeg' | string;
      quality?: number;
      fullRes?: boolean;
    })
  | (BrowserActionBase & {
      action: 'navigate';
      op?: 'url' | 'back' | 'forward' | 'reload' | string;
      url?: string;
      wait?: boolean;
      waitMs?: number;
      tabId?: number;
    })
  | (BrowserActionBase & {
      action: 'click';
      tabId?: number;
      ref?: string;
      selector?: string;
      text?: string;
      x?: number;
      y?: number;
      button?: 'left' | 'right' | 'middle' | string;
      double?: boolean;
    })
  | (BrowserActionBase & { action: 'type'; tabId?: number; ref?: string; selector?: string; text?: string })
  | (BrowserActionBase & { action: 'press_key'; tabId?: number; ref?: string; selector?: string; keys?: string[]; key?: string })
  | (BrowserActionBase & { action: 'hover'; tabId?: number; ref?: string; selector?: string; text?: string; x?: number; y?: number })
  | (BrowserActionBase & { action: 'scroll'; tabId?: number; ref?: string; selector?: string; dx?: number; dy?: number })
  | (BrowserActionBase & {
      action: 'select';
      tabId?: number;
      ref?: string;
      selector?: string;
      value?: string;
      text?: string;
    })
  | (BrowserActionBase & {
      action: 'fill_form';
      tabId?: number;
      fields?: Record<string, unknown>[] | AnyObject[];
    })
  | (BrowserActionBase & {
      action: 'wait_for';
      tabId?: number;
      ref?: string;
      text?: string;
      selector?: string;
      url?: string;
      timeoutMs?: number;
    })
  | (BrowserActionBase & {
      action: 'dialog';
      op?: 'accept' | 'dismiss' | string;
      promptText?: string;
      tabId?: number;
    })
  | (BrowserActionBase & { action: 'evaluate'; tabId?: number; expression?: string; frame?: string })
  | (BrowserActionBase & { action: 'console'; tabId?: number; level?: string; limit?: number })
  | (BrowserActionBase & {
      action: 'network';
      tabId?: number;
      limit?: number;
      filter?: string;
      type?: string;
      frame?: string;
      status?: string;
      media?: boolean;
      headers?: boolean;
      clear?: boolean;
      reload?: boolean;
      waitMs?: number;
      watch?: boolean;
    })
  | (BrowserActionBase & {
      action: 'network_body';
      tabId?: number;
      requestId: string;
      maxBytes?: number;
    })
  | (BrowserActionBase & { action: 'frames'; tabId?: number })
  | (BrowserActionBase & {
      action: 'upload';
      tabId?: number;
      ref?: string;
      selector?: string;
      fileName?: string;
      contentBase64?: string;
      mimeType?: string;
      files?: Record<string, unknown>[] | AnyObject[];
    })
  | (BrowserActionBase & { action: 'acquire_lock'; name?: string; minutes?: number; note?: string })
  | (BrowserActionBase & { action: 'release_lock'; name?: string; force?: boolean })
  | (BrowserActionBase & { action: 'reload'; checkOnly?: boolean; onlyIfChanged?: boolean })
  | (BrowserActionBase & {
      action: 'record_start';
      tabId?: number;
      mode?: 'video' | 'audio' | 'both' | string;
      audio?: boolean;
      fps?: number;
      maxSeconds?: number;
      format?: string;
      bitrate?: number;
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
      cursor?: boolean;
    })
  | (BrowserActionBase & { action: 'record_status' })
  | (BrowserActionBase & { action: 'record_stop'; save?: string; filename?: string; caption?: string; discard?: boolean });

export const BROWSER_TOOL_NAMES = [
  'browser_list',
  'browser_tabs',
  'browser_snapshot',
  'browser_read',
  'browser_screenshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_scroll',
  'browser_select',
  'browser_fill_form',
  'browser_wait_for',
  'browser_dialog',
  'browser_evaluate',
  'browser_console',
  'browser_network',
  'browser_network_body',
  'browser_frames',
  'browser_upload',
  'browser_acquire_lock',
  'browser_release_lock',
  'browser_reload',
  'browser_record_start',
  'browser_record_status',
  'browser_record_stop',
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
