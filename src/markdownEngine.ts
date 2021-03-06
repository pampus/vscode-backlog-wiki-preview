/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { TableOfContentsProvider } from './tableOfContentsProvider';
import { MarkdownIt, Token } from 'markdown-it';

const FrontMatterRegex = /^---\s*[^]*?(-{3}|\.{3})\s*/;

export class MarkdownEngine {
	private md!: MarkdownIt;

	private firstLine!: number;

	private currentDocument!: vscode.Uri;

	private plugins: Array<(md: any) => any> = [];

	public addPlugin(factory: (md: any) => any): void {
		if (this.md) {
			this.usePlugin(factory);
		} else {
			this.plugins.push(factory);
		}
	}

	private usePlugin(factory: (md: any) => any): void {
		try {
			this.md = factory(this.md);
		} catch (e) {
			// noop
		}
	}

	private async getEngine(): Promise<MarkdownIt> {
		if (!this.md) {
			const hljs = await import('highlight.js');
			const mdnh = await import('markdown-it-named-headers');
			this.md = (await import('markdown-it'))({
				html: true,
				breaks: true,
				highlight: (str: string, lang: string) => {
					// Workaround for highlight not supporting tsx: https://github.com/isagalaev/highlight.js/issues/1155
					if (lang && ['tsx', 'typescriptreact'].indexOf(lang.toLocaleLowerCase()) >= 0) {
						lang = 'jsx';
					}
					if (lang && hljs.getLanguage(lang)) {
						try {
							return `<pre class="hljs"><code><div>${hljs.highlight(lang, str, true).value}</div></code></pre>`;
						} catch (error) { }
					}
					return `<pre class="hljs"><code><div>${hljs.highlightAuto(str).value}</div></code></pre>`; // For backlog
				}
			}).use(mdnh, {
				slugify: (header: string) => TableOfContentsProvider.slugify(header)
			});

			for (const plugin of this.plugins) {
				this.usePlugin(plugin);
			}
			this.plugins = [];

			for (const renderName of ['paragraph_open', 'heading_open', 'image', 'code_block', 'blockquote_open', 'list_item_open']) {
				this.addLineNumberRenderer(this.md, renderName);
			}

			for (const renderName of ['thead_open', 'tbody_open']) { // For backlog
				this.addLineNumberRenderer(this.md, renderName);
			}

			this.addLinkNormalizer(this.md);
			this.addLinkValidator(this.md);
		}

		this.md.set({
			breaks: true, // For backlog
			linkify: true // For backlog
		});
		return this.md;
	}

	private stripFrontmatter(text: string): { text: string, offset: number } {
		let offset = 0;
		const frontMatterMatch = FrontMatterRegex.exec(text);
		if (frontMatterMatch) {
			const frontMatter = frontMatterMatch[0];
			offset = frontMatter.split(/\r\n|\n|\r/g).length - 1;
			text = text.substr(frontMatter.length);
		}
		return { text, offset };
	}

	public async render(document: vscode.Uri, stripFrontmatter: boolean, text: string): Promise<string> {
		let offset = 0;
		if (stripFrontmatter) {
			const markdownContent = this.stripFrontmatter(text);
			offset = markdownContent.offset;
			text = markdownContent.text;
		}
		this.currentDocument = document;
		this.firstLine = offset;
		const engine = await this.getEngine();
		return engine.render(text);
	}

	public async parse(document: vscode.Uri, source: string): Promise<Token[]> {
		const { text, offset } = this.stripFrontmatter(source);
		this.currentDocument = document;
		const engine = await this.getEngine();

		return engine.parse(text, {}).map(token => {
			if (token.map) {
				token.map[0] += offset;
			}
			return token;
		});
	}

	private addLineNumberRenderer(md: any, ruleName: string): void {
		const original = md.renderer.rules[ruleName];
		md.renderer.rules[ruleName] = (tokens: Array<Token>, idx: number, options: any, env: any, self: any) => {
			const offset = this.getBacklog2MarkdownOffset(tokens, idx); // For backlog
			const token = tokens[idx];
			if (token.map && token.map.length) {
				token.attrSet('data-line', (this.firstLine + token.map[0] - offset).toString()); // For backlog
				token.attrJoin('class', 'code-line');
			}

			if (original) {
				return original(tokens, idx, options, env, self);
			} else {
				return self.renderToken(tokens, idx, options, env, self);
			}
		};
	}

	private addLinkNormalizer(md: any): void {
		const normalizeLink = md.normalizeLink;
		md.normalizeLink = (link: string) => {
			try {
				let uri = vscode.Uri.parse(link);
				if (!uri.scheme && uri.path) {
					// Assume it must be a file
					const fragment = uri.fragment;
					if (uri.path[0] === '/') {
						const root = vscode.workspace.getWorkspaceFolder(this.currentDocument);
						if (root) {
							uri = vscode.Uri.file(path.join(root.uri.fsPath, uri.path));
						}
					} else {
						uri = vscode.Uri.file(path.join(path.dirname(this.currentDocument.path), uri.path));
					}

					if (fragment) {
						uri = uri.with({ fragment });
					}
					return normalizeLink(uri.toString(true));
				}
			} catch (e) {
				// noop
			}
			return normalizeLink(link);
		};
	}

	private addLinkValidator(md: any): void {
		const validateLink = md.validateLink;
		md.validateLink = (link: string) => {
			// support file:// links
			return validateLink(link) || link.indexOf('file:') === 0;
		};
	}

	// For backlog
	private backlogOffsets: Map<string, number> = new Map([
		['table_open', 1]
	]);

	private getBacklog2MarkdownOffset(tokens: Array<Token>, idx: number): number {
		if (tokens.length === 0) {
			return 0;
		}
		return tokens.slice(0, idx - 1)
					.filter(token => this.backlogOffsets.has(token.type))
					.map(token => this.backlogOffsets.get(token.type) as number)
					.reduce((pv, cv) => pv + cv, 0);
	}
}