/**
 * Shared types for leader-key extension.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ActionItem {
	key: string; // single character shortcut
	label: string;
	description?: string;
	action: (ctx: ExtensionContext) => void | Promise<void>;
}

export interface ActionGroup {
	key: string; // chord key to open this group
	label: string;
	items: ActionItem[];
}

/** Top-level entry: either a group (chord → submenu) or a direct action */
export type TopLevelEntry =
	| { type: "group"; group: ActionGroup }
	| { type: "action"; key: string; label: string; description?: string; action: (ctx: ExtensionContext) => void | Promise<void> };
