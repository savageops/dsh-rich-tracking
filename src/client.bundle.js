window.__ModuleLoader__.load({
	id: "dsh-rich-tracking",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/cx.js
		function cx() {
			let out = "";
			for (const entry of arguments) {
				if (!entry) continue;
				if (typeof entry === "string" || typeof entry === "number") out += (out ? " " : "") + entry;
				else if (Array.isArray(entry)) { const nested = cx(...entry); if (nested) out += (out ? " " : "") + nested; }
				else for (const [key, value] of Object.entries(entry)) if (value) out += (out ? " " : "") + key;
			}
			return out;
		}
		//#endregion
		//#region lib/transport.js
		const API = "/api/rich-tracking";
		/** Fire one operator action; resolves {ok, delivered} or throws with the host's error. */
		async function postAction(sessionId, kind, rowId) {
			const res = await fetch(`${API}/action`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(rowId === undefined ? { sessionId, kind } : { sessionId, kind, rowId }),
			});
			const body = await res.json().catch(() => ({ ok: false, error: "bad-host-response" }));
			if (!res.ok || body.ok !== true) throw new Error(body.error ?? `action failed: HTTP ${res.status}`);
			return body;
		}
		/** Relative "x ago" at minute granularity, capped at "1h+". */
		function relativeMinutes(at, now) {
			const minutes = Math.max(0, Math.floor((now - at) / 60_000));
			if (minutes < 1) return "now";
			if (minutes >= 60) return "1h+";
			return `${minutes}m`;
		}
		//#endregion
		//#region lib/locales.js
		const NS = "rich-tracking";
		const en = {
			"title": "Tracking",
			"board.done": "done",
			"rows": "rows",
			"row.basis": "basis:",
		"row.items": "items",
		"row.expand": "show row items",
		"row.collapse": "hide row items",
			"action.pursue": "Pursue",
			"action.pursue.hint": "Make this row the agent's next focus — lands as an instruction in its next step.",
		"action.delegate": "Delegate",
		"action.delegate.hint": "Hand this row to a background subagent with read/write access — the delegation instruction carries the row's details and progress; the subagent tracks its own board scoped to this task.",
			"action.align": "Align",
			"action.align.hint": "Force a re-derivation of every percent from the named artifacts — the lie-detector pass.",
			"action.alignRow.hint": "Re-derive this row's percent from its evidence artifacts.",
			"action.dismiss": "Dismiss",
			"action.dismiss.hint": "Dismiss the whole board (a later tracking_write re-opens it).",
			"action.dismissRow.hint": "Dismiss this row from the board.",
			"action.checkpoint": "Checkpoint",
			"action.checkpoint.hint": "Ask the agent to take a tracking checkpoint now (host captures git + board).",
			"checkpoint.since": "since checkpoint",
			"checkpoint.commits": "commits",
			"checkpoint.expand": "Show frozen snapshot",
			"checkpoint.collapse": "Hide frozen snapshot",
			"checkpoint.gitUnavailable": "git state unavailable",
			"checkpoint.dirty": "dirty",
			"checkpoint.clean": "clean",
			"status.delivered": "delivered",
			"status.steer": "lands at the next step boundary",
			"status.followup": "opens a new turn",
			"status.inject": "delivered quietly",
			"error.offline": "Session offline — copy the instruction into the composer instead.",
			"error.generic": "Action failed",
			"decision.pursue": "pursue",
			"decision.align": "align",
			"decision.dismiss": "dismiss",
			"decision.dismiss-row": "dismiss row",
			"decision.checkpoint-request": "checkpoint",
			"ago": "ago"
		};
		const zh = {
			"title": "进度",
			"board.done": "完成",
			"rows": "行",
			"row.basis": "依据：",
		"row.items": "项",
		"row.expand": "展开行内条目",
		"row.collapse": "收起行内条目",
			"action.pursue": "推进",
			"action.pursue.hint": "让这一行成为 agent 的下一个工作重点——作为指令送达它的下一步。",
		"action.delegate": "委派",
		"action.delegate.hint": "把这一行交给拥有读写权限的后台子代理——委派指令携带该行的详情与进度；子代理在自己的会话里维护只属于此任务的看板。",
			"action.align": "对齐",
			"action.align.hint": "强制从证据工件重新推导所有百分比——测谎通道。",
			"action.alignRow.hint": "从该行的证据工件重新推导其百分比。",
			"action.dismiss": "关闭",
			"action.dismiss.hint": "关闭整个看板（之后任何 tracking_write 会重新打开它）。",
			"action.dismissRow.hint": "从看板上移除该行。",
			"action.checkpoint": "检查点",
			"action.checkpoint.hint": "让 agent 现在就打一个进度检查点（宿主抓取 git + 看板）。",
			"checkpoint.since": "自检查点以来",
			"checkpoint.commits": "个提交",
			"checkpoint.expand": "展开冻结快照",
			"checkpoint.collapse": "收起冻结快照",
			"checkpoint.gitUnavailable": "git 状态不可用",
			"checkpoint.dirty": "处未提交",
			"checkpoint.clean": "干净",
			"status.delivered": "已送达",
			"status.steer": "将在下一步边界生效",
			"status.followup": "开启新回合",
			"status.inject": "已静默送达",
			"error.offline": "会话离线——请把指令复制到输入框手动发送。",
			"error.generic": "操作失败",
			"decision.pursue": "推进",
			"decision.align": "对齐",
			"decision.dismiss": "关闭",
			"decision.dismiss-row": "移除行",
			"decision.checkpoint-request": "检查点",
			"ago": "前"
		};
		//#endregion
		//#region lib/styles.css
		const css = `.rt-root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex:none;margin:0 auto;overflow:hidden}
.rt-root,.rt-root *{box-sizing:border-box}
.rt-body{flex-direction:column;gap:0;padding:6px 0 6px;display:flex}
.rt-header{text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:10px;width:100%;padding:0 12px;display:flex}
.rt-header:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:8px}
.rt-disc{flex:none;width:14px;height:14px;border-radius:50%;background:conic-gradient(var(--rt-fill-color) var(--rt-percent), var(--dsw-alias-interactive-bg-hover) 0);position:relative}
.rt-disc:after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--dsw-specific-tip)}
.rt-title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}
.rt-progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;font-weight:400;line-height:20px;overflow:hidden}
.rt-chip{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px;flex:none}
.rt-headerActions{flex:none;align-items:stretch;display:flex;margin:-6px -12px -6px 0}
.rt-headerActions .rt-iconBtn{width:34px;height:auto;border-radius:0;border-left:1px solid var(--dsw-alias-border-l1)}
.rt-headerActions .rt-chevron{border-left:1px solid var(--dsw-alias-border-l1);width:34px}
.rt-iconBtn{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;padding:0;display:grid}
.rt-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rt-iconBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.rt-iconBtn:disabled{opacity:.45;cursor:default}
.rt-chevron{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}
.rt-list{flex-direction:column;gap:0;max-height:180px;margin:0;padding:0;list-style:none;display:flex;overflow-y:auto}
.rt-row:hover,.rt-row:focus-within,.rt-rowOpen{background:var(--dsw-alias-interactive-bg-hover)}
.rt-list .rt-row:last-child{border-bottom:none}
.rt-row{border-radius:0;align-items:flex-start;gap:10px;width:100%;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex}
.rt-rowDim{opacity:.55}
.rt-rowHasItems{cursor:pointer}
.rt-rowHasItems:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.rt-rowChevron{color:var(--dsw-alias-label-tertiary);flex:none;align-self:center;place-items:center;display:grid}
.rt-itemCount{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;flex:none}
.rt-itemList{border-left:2px solid var(--dsw-alias-border-l1);margin:3px 0 1px 1px;padding-left:8px;flex-direction:column;gap:1px;display:flex}
.rt-item{align-items:flex-start;gap:7px;min-width:0;display:flex}
.rt-itemGlyph{color:inherit;flex:none;place-items:center;width:14px;height:14px;margin-top:1px;display:grid}
.rt-itemDone{color:var(--dsw-alias-label-caption)}
.rt-itemOpen{color:var(--dsw-alias-state-business-primary)}
.rt-itemLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;min-width:0;overflow-wrap:anywhere}
.rt-itemDone .rt-itemLabel{color:var(--dsw-alias-label-caption);text-decoration:line-through;text-decoration-thickness:1px}
.rt-glyph{flex:none;place-items:center;width:16px;height:16px;margin-top:2px;display:grid}
.rt-glyphDone{color:var(--dsw-alias-state-success-primary)}
.rt-glyphActive{color:var(--dsw-alias-state-business-primary)}
.rt-glyphActive svg{animation:rt-spin 1s linear infinite}
.rt-glyphBlocked{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}
.rt-glyphPending{color:var(--dsw-alias-label-caption)}
@keyframes rt-spin{to{transform:rotate(360deg)}}
.rt-rowMain{min-width:0;flex:auto;display:flex;flex-direction:column;gap:1px}
.rt-rowLine{display:flex;align-items:center;gap:8px;min-width:0}
.rt-rowLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:400;line-height:20px;text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.rt-rowPercent{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;flex:none;min-width:34px;text-align:right}
.rt-bar{width:64px;height:3px;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;overflow:hidden;flex:none;align-self:center}
.rt-barFill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:999px;transition:width 160ms ease}
.rt-rowDim .rt-barFill{background:var(--dsw-alias-state-success-primary)}
.rt-rowActions{flex:none;align-items:center;gap:2px;display:flex;visibility:hidden}
.rt-row:hover .rt-rowActions,.rt-row:focus-within .rt-rowActions{visibility:visible}
.rt-rowNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.rt-rowEvidence{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;overflow-wrap:anywhere;opacity:.85}
.rt-checkpoint{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px 2px;display:flex;flex-direction:column;gap:3px}
.rt-cpLine{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.rt-cpSince{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;overflow-wrap:anywhere}
.rt-cpToggle{color:var(--dsw-alias-state-business-primary);cursor:pointer;background:0 0;border:none;border-radius:6px;font-size:12px;line-height:16px;padding:1px 4px;justify-content:flex-start;width:max-content}
.rt-cpToggle:hover{text-decoration:underline}
.rt-frozen{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-markdown-code-block);padding:6px 10px;display:flex;flex-direction:column;gap:2px}
.rt-frozenRow{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;display:flex;justify-content:space-between;gap:10px}
.rt-status{min-height:16px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;padding:0 12px}
.rt-statusOk{color:var(--dsw-alias-state-success-primary)}
.rt-statusError{color:var(--dsw-alias-state-error-primary)}`;
		const tagId = "dsh-rich-tracking/board.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-rich-tracking";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region lib/components.js
		/** Glyphs cloned from the built-in TodoPanel (native SVGs, not primitive icons): gradient spinner ring, circle-check, dashed pending ring. */
		function ProgressGlyph() {
			const gradientId = (0, react.useId)();
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true",
				children: [
					(0, react_jsx_runtime.jsx)("defs", { children: (0, react_jsx_runtime.jsxs)("linearGradient", {
						id: gradientId, x1: "2.5", y1: "12", x2: "10.5", y2: "3.5", gradientUnits: "userSpaceOnUse",
						children: [
							(0, react_jsx_runtime.jsx)("stop", { stopColor: "currentColor" }),
							(0, react_jsx_runtime.jsx)("stop", { offset: "1", stopColor: "currentColor", stopOpacity: "0" })
						]
					}) }),
					(0, react_jsx_runtime.jsx)("circle", { cx: "7", cy: "7", r: "6.4", stroke: `url(#${gradientId})`, strokeWidth: "1.2" })
				]
			});
		}
		function CompletedGlyph() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true",
				children: [
					(0, react_jsx_runtime.jsx)("circle", { cx: "7", cy: "7", r: "6.4", stroke: "currentColor", strokeWidth: "1.2" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z", fill: "currentColor" })
				]
			});
		}
		function PendingGlyph() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true",
				children: (0, react_jsx_runtime.jsx)("circle", { cx: "7", cy: "7", r: "6.4", stroke: "currentColor", strokeWidth: "1.2", strokeDasharray: "2.4 2.4" })
			});
		}
		/** Row status glyph, TodoPanel grammar: gradient spinner for active, circle-check for done, warning for blocked, dashed ring for pending. */
		function RowGlyph({ status }) {
			if (status === "done") return (0, react_jsx_runtime.jsx)("span", { className: "rt-glyph rt-glyphDone", children: (0, react_jsx_runtime.jsx)(CompletedGlyph, {}) });
			if (status === "active") return (0, react_jsx_runtime.jsx)("span", { className: "rt-glyph rt-glyphActive", children: (0, react_jsx_runtime.jsx)(ProgressGlyph, {}) });
			if (status === "blocked") return (0, react_jsx_runtime.jsx)("span", { className: "rt-glyph rt-glyphBlocked", children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, { size: 14 }) });
			return (0, react_jsx_runtime.jsx)("span", { className: "rt-glyph rt-glyphPending", children: (0, react_jsx_runtime.jsx)(PendingGlyph, {}) });
		}
		/** Delegate icon: the person/agent glyph when the runtime primitives carry it, queue glyph as fallback. */
		const DelegateIcon = _deepseek_ai_dsh_client_ui_primitives.IconUserOutline16 ?? _deepseek_ai_dsh_client_ui_primitives.IconQueueOutline14;
		/** Tooltip-wrapped icon action (exemplar PreflightButton pattern: 500ms tooltip naming verb + consequence). */
		function ActionButton({ label, hint, disabled, onClick, children }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: hint,
				side: "top",
				delayMs: 500,
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "rt-iconBtn",
					"aria-label": label,
					disabled,
					onClick: (event) => { event.stopPropagation(); onClick(); },
					children
				})
			});
		}
		/** One board row: glyph, label, mini progressbar, percent, hover-revealed pursue/align/dismiss. Rows carrying `items` expand on click/Enter to show the acceptance checklist — done items grey + strikethrough, open items primary. */
		function BoardRow({ row, busy, onAction, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const items = Array.isArray(row.items) ? row.items : [];
			const hasItems = items.length > 0;
			const doneCount = items.filter((item) => item.done === true).length;
			const toggle = () => setOpen((value) => !value);
			const expandProps = hasItems === true ? {
				role: "button",
				tabIndex: 0,
				"aria-expanded": open,
				"aria-label": `${row.label} — ${open === true ? t("row.collapse") : t("row.expand")}`,
				onClick: toggle,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggle(); }
					else if (event.key === "Escape" && open === true) { event.stopPropagation(); setOpen(false); }
				}
			} : {};
			return (0, react_jsx_runtime.jsxs)("li", {
				className: cx("rt-row", row.dimmed && "rt-rowDim", hasItems && "rt-rowHasItems", open && "rt-rowOpen"),
				"data-status": row.status,
				...expandProps,
				children: [
					(0, react_jsx_runtime.jsx)(RowGlyph, { status: row.status }),
					(0, react_jsx_runtime.jsxs)("span", {
						className: "rt-rowMain",
						children: [
							(0, react_jsx_runtime.jsxs)("span", {
								className: "rt-rowLine",
								children: [
									(0, react_jsx_runtime.jsx)("span", { className: "rt-rowLabel", title: row.label, children: row.label }),
									(0, react_jsx_runtime.jsx)("span", {
										className: "rt-bar",
										role: "progressbar",
										"aria-valuemin": 0,
										"aria-valuemax": 100,
										"aria-valuenow": row.percent,
										"aria-label": row.label,
										children: (0, react_jsx_runtime.jsx)("span", { className: "rt-barFill", style: { width: `${row.percent}%` } })
									}),
									(0, react_jsx_runtime.jsx)("span", { className: "rt-rowPercent", children: `${row.percent}%` }),
									hasItems === true ? (0, react_jsx_runtime.jsx)("span", { className: "rt-itemCount", children: `${doneCount}/${items.length} ${t("row.items")}` }) : null
								]
							}),
							row.note !== undefined ? (0, react_jsx_runtime.jsx)("span", { className: "rt-rowNote", children: row.note }) : null,
							row.evidence !== undefined ? (0, react_jsx_runtime.jsx)("span", { className: "rt-rowEvidence", children: `${t("row.basis")} ${row.evidence}` }) : null,
							open === true && hasItems === true ? (0, react_jsx_runtime.jsx)("span", {
								className: "rt-itemList",
								children: items.map((item, index) => (0, react_jsx_runtime.jsxs)("span", {
									className: cx("rt-item", item.done === true ? "rt-itemDone" : "rt-itemOpen"),
									children: [
										(0, react_jsx_runtime.jsx)("span", { className: "rt-itemGlyph", children: item.done === true ? (0, react_jsx_runtime.jsx)(CompletedGlyph, {}) : (0, react_jsx_runtime.jsx)(PendingGlyph, {}) }),
										(0, react_jsx_runtime.jsx)("span", { className: "rt-itemLabel", children: item.label })
									]
								}, index))
							}) : null
						]
					}),
					hasItems === true ? (0, react_jsx_runtime.jsx)("span", {
						className: "rt-rowChevron",
						"aria-hidden": "true",
						children: open === true ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, {})
					}) : null,
					(0, react_jsx_runtime.jsxs)("span", {
						className: "rt-rowActions",
						children: [
							(0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("action.pursue"),
								hint: t("action.pursue.hint"),
								disabled: busy,
								onClick: () => onAction("pursue", row.id),
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSendOutline14, {})
							}),
							(0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("action.delegate"),
								hint: t("action.delegate.hint"),
								disabled: busy,
								onClick: () => onAction("delegate", row.id),
								children: (0, react_jsx_runtime.jsx)(DelegateIcon, { size: 14 })
							}),
							(0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("action.align"),
								hint: t("action.alignRow.hint"),
								disabled: busy,
								onClick: () => onAction("align", row.id),
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
							}),
							(0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("action.dismiss"),
								hint: t("action.dismissRow.hint"),
								disabled: busy,
								onClick: () => onAction("dismiss-row", row.id),
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {})
							})
						]
					})
				]
			});
		}
		/** The checkpoint strip: frozen git truth + since-checkpoint deltas, expandable to the full snapshot. */
		function CheckpointStrip({ view, t }) {
			const [showFrozen, setShowFrozen] = (0, react.useState)(false);
			const cp = view.lastCheckpoint;
			const since = view.sinceCheckpoint;
			if (cp === undefined) return null;
			const deltas = since?.rowDeltas?.map((delta) => `${delta.label} ${delta.from}%\u2192${delta.to}%`).join(" \u00b7 ") ?? "";
			const before = view.overallPercent - (since?.percentDelta ?? 0);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "rt-checkpoint",
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: "rt-cpLine",
						children: `checkpoint ${cp.id}${cp.label !== null && cp.label !== undefined ? ` \u00b7 "${cp.label}"` : ""} \u00b7 ${new Date(cp.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} \u00b7 ${cp.git !== null && cp.git !== undefined ? `${cp.git.branch}@${cp.git.head.slice(0, 7)} (${cp.git.dirtyCount > 0 ? `${cp.git.dirtyCount} ${t("checkpoint.dirty")}` : t("checkpoint.clean")})` : t("checkpoint.gitUnavailable")}`
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: "rt-cpSince",
						children: `${t("checkpoint.since")}: ${since?.commitsAhead !== null && since?.commitsAhead !== undefined ? `+${since.commitsAhead} ${t("checkpoint.commits")} \u00b7 ` : ""}overall ${before}% \u2192 ${view.overallPercent}%${deltas === "" ? "" : ` \u00b7 ${deltas}`}`
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rt-cpToggle",
						onClick: () => setShowFrozen((value) => !value),
						children: showFrozen ? t("checkpoint.collapse") : t("checkpoint.expand")
					}),
					showFrozen ? (0, react_jsx_runtime.jsx)("div", {
						className: "rt-frozen",
						children: cp.rows.map((row) => (0, react_jsx_runtime.jsxs)("span", { className: "rt-frozenRow", children: [(0, react_jsx_runtime.jsx)("span", { children: row.label }), (0, react_jsx_runtime.jsx)("span", { children: `${row.percent}%` })] }, row.id))
					}) : null
				]
			});
		}
		//#endregion
		//#region lib/TrackingDock.js
		/**
		 * The scoreboard dock entry (order 5): renders the host-computed
		 * 'tracking' projection. Absent or dismissed board renders nothing —
		 * the plugin is inert until the first tracking_write.
		 */
		function TrackingDock({ useProjection, sessionId, t }) {
			const view = useProjection("tracking");
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [delivered, setDelivered] = (0, react.useState)(null);
			const [expanded, setExpanded] = (0, react.useState)(false);
			const [now, setNow] = (0, react.useState)(Date.now());
			(0, react.useEffect)(() => {
				const timer = window.setInterval(() => setNow(Date.now()), 30_000);
				return () => window.clearInterval(timer);
			}, []);
			if (view === null || view === undefined || view.present !== true) return null;

			const act = (kind, rowId) => {
				setBusy(kind + (rowId ?? ""));
				setError(null);
				setDelivered(null);
				postAction(sessionId, kind, rowId).then((body) => {
					setDelivered(body.delivered);
					setBusy(null);
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : String(cause));
					setBusy(null);
				});
			};

			const fillColor = view.allDone === true ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-business-primary)";
			const counter = view.allDone === true
				? `${view.doneCount}/${view.rows.length} ${t("rows")} \u00b7 ${t("board.done")}`
				: `${view.doneCount}/${view.rows.length} ${t("rows")} \u00b7 ${view.overallPercent}%`;
			const decisionChip = view.lastDecision !== undefined && now - view.lastDecision.at < 10 * 60_000
				? `${t(`decision.${view.lastDecision.kind}`)} \u00b7 ${relativeMinutes(view.lastDecision.at, now)} ${t("ago")}`
				: null;

			return (0, react_jsx_runtime.jsx)("div", {
				className: "rt-root",
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: "rt-body",
					onKeyDown: (event) => {
						if (event.key === "Escape" && expanded === true) { event.stopPropagation(); setExpanded(false); }
					},
					children: [
						(0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "rt-header",
							"aria-expanded": expanded,
							"aria-controls": "rt-panel",
							onClick: () => setExpanded((value) => !value),
							children: [
								(0, react_jsx_runtime.jsx)("span", { className: "rt-disc", style: { "--rt-percent": `${view.overallPercent * 3.6}deg`, "--rt-fill-color": fillColor }, "aria-hidden": "true" }),
								(0, react_jsx_runtime.jsx)("span", { className: "rt-title", children: t("title") }),
								(0, react_jsx_runtime.jsx)("span", { className: "rt-progress", children: counter }),
								decisionChip !== null ? (0, react_jsx_runtime.jsx)("span", { className: "rt-chip", children: decisionChip }) : null,
								(0, react_jsx_runtime.jsxs)("span", {
									className: "rt-headerActions",
									children: [
										(0, react_jsx_runtime.jsx)(ActionButton, {
											label: t("action.align"),
											hint: t("action.align.hint"),
											disabled: busy !== null,
											onClick: () => act("align"),
											children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
										}),
										(0, react_jsx_runtime.jsx)(ActionButton, {
											label: t("action.checkpoint"),
											hint: t("action.checkpoint.hint"),
											disabled: busy !== null,
											onClick: () => act("checkpoint-request"),
											children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {})
										}),
										(0, react_jsx_runtime.jsx)(ActionButton, {
											label: t("action.dismiss"),
											hint: t("action.dismiss.hint"),
											disabled: busy !== null,
											onClick: () => act("dismiss"),
											children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {})
										}),
										(0, react_jsx_runtime.jsx)("span", { className: "rt-chevron", "aria-hidden": "true", children: expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, {}) })
									]
								})
							]
						}),
						expanded ? (0, react_jsx_runtime.jsx)("ul", {
							id: "rt-panel",
							className: "rt-list",
							role: "region",
							"aria-label": t("title"),
							children: view.rows.map((row) => (0, react_jsx_runtime.jsx)(BoardRow, { row, busy: busy !== null, onAction: act, t }, row.id))
						}) : null,
						expanded && view.lastCheckpoint !== undefined ? (0, react_jsx_runtime.jsx)(CheckpointStrip, { view, t }) : null,
						expanded && (error !== null || delivered !== null) ? (0, react_jsx_runtime.jsx)("span", {
							className: cx("rt-status", error === null && "rt-statusOk", error !== null && "rt-statusError"),
							role: error !== null ? "alert" : "status",
							children: error !== null
								? (error === "session-offline" ? t("error.offline") : `${t("error.generic")}: ${error}`)
								: `${t("status.delivered")} \u2014 ${t(`status.${delivered}`)}`
						}) : null
					]
				})
			});
		}
		//#endregion
		//#region lib/index.js
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "rich-tracking: dictionaries");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "tracking",
				order: 5,
				locale: NS
			}, TrackingDock));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
