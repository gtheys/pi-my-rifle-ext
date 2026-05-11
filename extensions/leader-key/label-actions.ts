/**
 * Label (bookmark) related leader-key actions.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import type { TopLevelEntry } from "./types.js";
import { searchableSelect } from "./model-switcher.js";
import { collectLabeledEntries, tryNavigateTree } from "./context-helpers.js";

const PRESET_LABELS = [
	{ key: "r", label: "research", description: "mark as research" },
	{ key: "p", label: "plan", description: "mark as plan" },
];

export function buildLabelEntries(pi: ExtensionAPI): TopLevelEntry {
	return {
		type: "group",
		group: {
			key: "l",
			label: "Label",
			items: [
				...PRESET_LABELS.map((preset) => ({
					key: preset.key,
					label: preset.label,
					description: preset.description,
					action: (ctx: ExtensionContext) => {
						const leafId = ctx.sessionManager.getLeafId();
						if (!leafId) {
							ctx.ui.notify("No current entry to label", "error");
							return;
						}
						pi.setLabel(leafId, preset.label);
						ctx.ui.notify(`Labeled: ${preset.label}`, "info");
					},
				})),
				{
					key: "c",
					label: "Custom label",
					description: "type your own",
					action: async (ctx: ExtensionContext) => {
						const leafId = ctx.sessionManager.getLeafId();
						if (!leafId) {
							ctx.ui.notify("No current entry to label", "error");
							return;
						}
						const allLabels = [...PRESET_LABELS.map((p) => p.label)];
						// Also collect labels already used in this session
						function collectExistingLabels(nodes: SessionTreeNode[]) {
							for (const node of nodes) {
								if (node.label && !allLabels.includes(node.label)) {
									allLabels.push(node.label);
								}
								collectExistingLabels(node.children);
							}
						}
						collectExistingLabels(ctx.sessionManager.getTree());

						const items = allLabels.map((l) => ({
							value: l,
							label: l,
							description: "label",
						}));
						const selected = await searchableSelect<string>(
							ctx,
							"Pick or search label",
							items,
							"type to filter, enter to select",
						);
						if (selected) {
							pi.setLabel(leafId, selected);
							ctx.ui.notify(`Labeled: ${selected}`, "info");
						}
					},
				},
				{
					key: "x",
					label: "Clear label",
					description: "pick labeled entry to clear",
					action: async (ctx: ExtensionContext) => {
						const labeled = collectLabeledEntries(ctx.sessionManager.getTree());

						if (labeled.length === 0) {
							ctx.ui.notify("No labeled entries found", "info");
							return;
						}

						const items = labeled.map((l) => ({
							value: l.id,
							label: `[${l.label}]`,
							description: l.preview || l.id.slice(0, 8),
						}));

						const selectedId = await searchableSelect<string>(
							ctx,
							"Clear label from entry",
							items,
						);

						if (selectedId) {
							pi.setLabel(selectedId, undefined);
							ctx.ui.notify("Label cleared", "info");
						}
					},
				},
				{
					key: "g",
					label: "Go to label",
					description: "jump to a labeled entry",
					action: async (ctx: ExtensionContext) => {
						const labeled = collectLabeledEntries(ctx.sessionManager.getTree());

						if (labeled.length === 0) {
							ctx.ui.notify("No labeled entries found", "info");
							return;
						}

						const items = labeled.map((l) => ({
							value: l.id,
							label: `[${l.label}]`,
							description: l.preview || l.id.slice(0, 8),
						}));

						const selectedId = await searchableSelect<string>(
							ctx,
							"Jump to labeled entry",
							items,
						);

						if (selectedId) {
							await tryNavigateTree(ctx, selectedId);
						}
					},
				},
			],
		},
	};
}
