// Smoke test: loads the bundled extension with a mocked `vscode` module and
// calls activate(). Catches runtime errors (wrong API usage, etc.) that
// tsc/esbuild can't catch since they don't type-check against the real
// vscode module at call time.
import { createRequire } from 'node:module';
import path from 'node:path';
import Module from 'node:module';

const registeredCommands = [];
let statusBarCreated = false;
let treeProviderRegistered = false;

class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    return (listener) => {
      this._listeners.push(listener);
      return { dispose() {} };
    };
  }
  fire(value) {
    for (const l of this._listeners) l(value);
  }
}

const vscodeMock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItem: class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  EventEmitter,
  Disposable: class Disposable {
    constructor(fn) {
      this._fn = fn;
    }
    dispose() {
      this._fn?.();
    }
  },
  Uri: {
    joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath ?? '.', ...segments), toString: () => 'mock-uri' }),
  },
  ViewColumn: { One: 1 },
  window: {
    createStatusBarItem: () => {
      statusBarCreated = true;
      return {
        show() {},
        dispose() {},
        set text(_v) {},
        set tooltip(_v) {},
        set backgroundColor(_v) {},
        set command(_v) {},
      };
    },
    registerTreeDataProvider: (_id, _provider) => {
      treeProviderRegistered = true;
      return { dispose() {} };
    },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showQuickPick: async () => undefined,
    createWebviewPanel: () => ({
      webview: { postMessage() {}, onDidReceiveMessage() { return { dispose() {} }; }, asWebviewUri: (u) => u, cspSource: 'mock' },
      onDidDispose() { return { dispose() {} }; },
      reveal() {},
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
    }),
    workspaceFolders: undefined,
    fs: {
      readFile: async () => {
        throw new Error('not found');
      },
      writeFile: async () => {},
    },
  },
  commands: {
    registerCommand: (id, handler) => {
      registeredCommands.push(id);
      return { dispose() {} };
    },
  },
};

// Intercept require('vscode') for the bundled CJS extension.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') {
    return 'vscode';
  }
  return originalResolve.call(this, request, ...rest);
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);
const { activate } = require('../dist/extension.js');

const store = new Map();
const secrets = new Map();

const context = {
  subscriptions: [],
  extensionUri: { fsPath: '.' },
  globalState: {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => {
      store.set(key, value);
    },
  },
  secrets: {
    get: async (key) => secrets.get(key),
    store: async (key, value) => {
      secrets.set(key, value);
    },
    delete: async (key) => {
      secrets.delete(key);
    },
  },
};

try {
  activate(context);
} catch (err) {
  console.error('FAIL: activate() threw:', err);
  process.exit(1);
}

const expectedCommands = [
  'keyRotator.openDashboard',
  'keyRotator.openChat',
  'keyRotator.addAccount',
  'keyRotator.activateAccount',
  'keyRotator.disableAccount',
  'keyRotator.deleteAccount',
  'keyRotator.editAccount',
  'keyRotator.reportRateLimit',
  'keyRotator.rotateNow',
];

const missing = expectedCommands.filter((c) => !registeredCommands.includes(c));

if (!statusBarCreated) {
  console.error('FAIL: status bar item was not created');
  process.exit(1);
}
if (!treeProviderRegistered) {
  console.error('FAIL: tree data provider was not registered');
  process.exit(1);
}
if (missing.length > 0) {
  console.error('FAIL: missing commands:', missing);
  process.exit(1);
}

// Clean up the interval started by startHealthCheckLoop so the process can exit.
for (const sub of context.subscriptions) {
  sub?.dispose?.();
}

console.log('PASS: activate() ran without errors, registered', registeredCommands.length, 'commands');
