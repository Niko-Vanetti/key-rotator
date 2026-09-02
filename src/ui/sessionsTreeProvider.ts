import * as vscode from 'vscode';
import type { SessionSummary } from '../chat/chatSession.js';

type Node = { kind: 'new' } | { kind: 'session'; session: SessionSummary };

function relTime(ms: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Activity-bar view that lists your named Claude sessions (the same local
 * store as native Claude Code). Selecting one opens the chat on it — reading
 * the transcript locally, with NO tokens spent until you actually send.
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private getSessions: () => SessionSummary[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'new') {
      const item = new vscode.TreeItem('New session', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('add');
      item.command = { command: 'keyRotator.newChatSession', title: 'New session' };
      item.contextValue = 'newSession';
      return item;
    }
    const { session } = node;
    const item = new vscode.TreeItem(session.name, vscode.TreeItemCollapsibleState.None);
    item.description = relTime(session.mtime);
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.tooltip = `${session.name} — abrir (sin gastar tokens hasta que escribas)`;
    item.id = session.id;
    item.contextValue = 'chatSession';
    item.command = {
      command: 'keyRotator.openChatSession',
      title: 'Abrir chat',
      arguments: [{ id: session.id }],
    };
    return item;
  }

  getChildren(element?: Node): Node[] {
    if (element) return [];
    const sessions = this.getSessions();
    return [{ kind: 'new' as const }, ...sessions.map((session) => ({ kind: 'session' as const, session }))];
  }
}
