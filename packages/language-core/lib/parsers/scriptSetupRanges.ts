import type * as ts from 'typescript';
import type { VueCompilerOptions, TextRange } from '../types';
import { collectVars } from '../codegen/common';

export interface ScriptSetupRanges extends ReturnType<typeof parseScriptSetupRanges> { }

export function parseScriptSetupRanges(
	ts: typeof import('typescript'),
	ast: ts.SourceFile,
	vueCompilerOptions: VueCompilerOptions
) {

	let foundNonImportExportNode = false;
	let importSectionEndOffset = 0;

	const props: {
		name?: string;
		destructured?: string[];
		define?: ReturnType<typeof parseDefineFunction> & {
			statement: TextRange;
		};
		withDefaults?: TextRange & {
			arg?: TextRange;
		};
	} = {};
	const slots: {
		name?: string;
		isObjectBindingPattern?: boolean;
		define?: ReturnType<typeof parseDefineFunction>;
	} = {};
	const emits: {
		name?: string;
		define?: ReturnType<typeof parseDefineFunction> & {
			hasUnionTypeArg?: boolean;
		};
	} = {};
	const expose: {
		name?: string;
		define?: ReturnType<typeof parseDefineFunction>;
	} = {};
	const options: {
		name?: string;
		inheritAttrs?: string;
	} = {};
	const cssModules: {
		exp: TextRange;
		arg?: TextRange;
	}[] = [];
	const templateRefs: {
		name?: string;
		define?: ReturnType<typeof parseDefineFunction>;
	}[] = [];

	const definePropProposalA = vueCompilerOptions.experimentalDefinePropProposal === 'kevinEdition' || ast.text.trimStart().startsWith('// @experimentalDefinePropProposal=kevinEdition');
	const definePropProposalB = vueCompilerOptions.experimentalDefinePropProposal === 'johnsonEdition' || ast.text.trimStart().startsWith('// @experimentalDefinePropProposal=johnsonEdition');
	const defineProp: {
		localName: TextRange | undefined;
		name: TextRange | undefined;
		type: TextRange | undefined;
		modifierType?: TextRange | undefined;
		runtimeType: TextRange | undefined;
		defaultValue: TextRange | undefined;
		required: boolean;
		isModel?: boolean;
	}[] = [];
	const bindings = parseBindingRanges(ts, ast);
	const text = ast.text;
	const leadingCommentEndOffset = ts.getLeadingCommentRanges(text, 0)?.reverse()[0].end ?? 0;
	const importComponentNames = new Set<string>();

	ts.forEachChild(ast, node => {
		const isTypeExport = (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword);
		if (
			!foundNonImportExportNode
			&& !ts.isImportDeclaration(node)
			&& !isTypeExport
			&& !ts.isEmptyStatement(node)
			// fix https://github.com/vuejs/language-tools/issues/1223
			&& !ts.isImportEqualsDeclaration(node)
		) {
			const commentRanges = ts.getLeadingCommentRanges(text, node.pos);
			if (commentRanges?.length) {
				const commentRange = commentRanges.sort((a, b) => a.pos - b.pos)[0];
				importSectionEndOffset = commentRange.pos;
			}
			else {
				importSectionEndOffset = getStartEnd(ts, node, ast).start;
			}
			foundNonImportExportNode = true;
		}

		if (
			ts.isImportDeclaration(node)
			&& node.importClause?.name
			&& !node.importClause.isTypeOnly
		) {
			const moduleName = getNodeText(ts, node.moduleSpecifier, ast).slice(1, -1);
			if (vueCompilerOptions.extensions.some(ext => moduleName.endsWith(ext))) {
				importComponentNames.add(getNodeText(ts, node.importClause.name, ast));
			}
		}
	});
	ts.forEachChild(ast, child => visitNode(child, [ast]));

	return {
		leadingCommentEndOffset,
		importSectionEndOffset,
		bindings,
		importComponentNames,
		props,
		slots,
		emits,
		expose,
		options,
		cssModules,
		defineProp,
		templateRefs,
	};

	function _getStartEnd(node: ts.Node) {
		return getStartEnd(ts, node, ast);
	}

	function parseDefineFunction(node: ts.CallExpression): TextRange & {
		arg?: TextRange;
		typeArg?: TextRange;
	} {
		return {
			..._getStartEnd(node),
			arg: node.arguments.length ? _getStartEnd(node.arguments[0]) : undefined,
			typeArg: node.typeArguments?.length ? _getStartEnd(node.typeArguments[0]) : undefined,
		};
	}

	function visitNode(node: ts.Node, parents: ts.Node[]) {
		const parent = parents[parents.length - 1];
		if (
			ts.isCallExpression(node)
			&& ts.isIdentifier(node.expression)
		) {
			const callText = getNodeText(ts, node.expression, ast);
			if (vueCompilerOptions.macros.defineModel.includes(callText)) {
				let localName: TextRange | undefined;
				let propName: TextRange | undefined;
				let options: ts.Node | undefined;

				if (
					ts.isVariableDeclaration(parent) &&
					ts.isIdentifier(parent.name)
				) {
					localName = _getStartEnd(parent.name);
				}

				if (node.arguments.length >= 2) {
					propName = _getStartEnd(node.arguments[0]);
					options = node.arguments[1];
				}
				else if (node.arguments.length >= 1) {
					if (ts.isStringLiteral(node.arguments[0])) {
						propName = _getStartEnd(node.arguments[0]);
					}
					else {
						options = node.arguments[0];
					}
				}

				let runtimeType: TextRange | undefined;
				let defaultValue: TextRange | undefined;
				let required = false;
				if (options && ts.isObjectLiteralExpression(options)) {
					for (const property of options.properties) {
						if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
							continue;
						}
						const text = getNodeText(ts, property.name, ast);
						if (text === 'type') {
							runtimeType = _getStartEnd(property.initializer);
						}
						else if (text === 'default') {
							defaultValue = _getStartEnd(property.initializer);
						}
						else if (text === 'required' && property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
							required = true;
						}
					}
				}
				defineProp.push({
					localName,
					name: propName,
					type: node.typeArguments?.length ? _getStartEnd(node.typeArguments[0]) : undefined,
					modifierType: node.typeArguments && node.typeArguments?.length >= 2 ? _getStartEnd(node.typeArguments[1]) : undefined,
					runtimeType,
					defaultValue,
					required,
					isModel: true,
				});
			}
			else if (callText === 'defineProp') {
				let localName: TextRange | undefined;
				let propName: TextRange | undefined;
				let options: ts.Node | undefined;

				if (
					ts.isVariableDeclaration(parent) &&
					ts.isIdentifier(parent.name)
				) {
					localName = _getStartEnd(parent.name);
				}

				let runtimeType: TextRange | undefined;
				let defaultValue: TextRange | undefined;
				let required = false;
				if (definePropProposalA) {
					if (node.arguments.length >= 2) {
						options = node.arguments[1];
					}
					if (node.arguments.length >= 1) {
						propName = _getStartEnd(node.arguments[0]);
					}

					if (options && ts.isObjectLiteralExpression(options)) {
						for (const property of options.properties) {
							if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
								continue;
							}
							const text = getNodeText(ts, property.name, ast);
							if (text === 'type') {
								runtimeType = _getStartEnd(property.initializer);
							}
							else if (text === 'default') {
								defaultValue = _getStartEnd(property.initializer);
							}
							else if (text === 'required' && property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
								required = true;
							}
						}
					}
				}
				else if (definePropProposalB) {
					if (node.arguments.length >= 3) {
						options = node.arguments[2];
					}
					if (node.arguments.length >= 2) {
						if (node.arguments[1].kind === ts.SyntaxKind.TrueKeyword) {
							required = true;
						}
					}
					if (node.arguments.length >= 1) {
						defaultValue = _getStartEnd(node.arguments[0]);
					}

					if (options && ts.isObjectLiteralExpression(options)) {
						for (const property of options.properties) {
							if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
								continue;
							}
							const text = getNodeText(ts, property.name, ast);
							if (text === 'type') {
								runtimeType = _getStartEnd(property.initializer);
							}
						}
					}
				}

				defineProp.push({
					localName,
					name: propName,
					type: node.typeArguments?.length ? _getStartEnd(node.typeArguments[0]) : undefined,
					runtimeType,
					defaultValue,
					required,
				});
			}
			else if (vueCompilerOptions.macros.defineSlots.includes(callText)) {
				slots.define = parseDefineFunction(node);
				if (ts.isVariableDeclaration(parent)) {
					if (ts.isIdentifier(parent.name)) {
						slots.name = getNodeText(ts, parent.name, ast);
					}
					else {
						slots.isObjectBindingPattern = ts.isObjectBindingPattern(parent.name);
					}
				}
			}
			else if (vueCompilerOptions.macros.defineEmits.includes(callText)) {
				emits.define = parseDefineFunction(node);
				if (ts.isVariableDeclaration(parent)) {
					emits.name = getNodeText(ts, parent.name, ast);
				}
				if (node.typeArguments?.length && ts.isTypeLiteralNode(node.typeArguments[0]) && node.typeArguments[0].members.at(0)) {
					for (const member of node.typeArguments[0].members) {
						if (ts.isCallSignatureDeclaration(member) && member.parameters[0].type && ts.isUnionTypeNode(member.parameters[0].type)) {
							emits.define.hasUnionTypeArg = true;
							return;
						}
					}
				}
			}
			else if (vueCompilerOptions.macros.defineExpose.includes(callText)) {
				expose.define = parseDefineFunction(node);
			}
			else if (vueCompilerOptions.macros.defineProps.includes(callText)) {
				if (ts.isVariableDeclaration(parent)) {
					if (ts.isObjectBindingPattern(parent.name)) {
						props.destructured = collectVars(ts, parent.name, ast, [], false);
					}
					else {
						props.name = getNodeText(ts, parent.name, ast);
					}
				}

				let statementRange: TextRange | undefined;
				for (let i = parents.length - 1; i >= 0; i--) {
					if (ts.isStatement(parents[i])) {
						const statement = parents[i];
						ts.forEachChild(statement, child => {
							const range = _getStartEnd(child);
							statementRange ??= range;
							statementRange.end = range.end;
						});
						break;
					}
				}
				if (!statementRange) {
					statementRange = _getStartEnd(node);
				}

				props.define = {
					...parseDefineFunction(node),
					statement: statementRange,
				};

				if (node.arguments.length) {
					props.define.arg = _getStartEnd(node.arguments[0]);
				}
				if (node.typeArguments?.length) {
					props.define.typeArg = _getStartEnd(node.typeArguments[0]);
				}
			}
			else if (vueCompilerOptions.macros.withDefaults.includes(callText)) {
				props.withDefaults = _getStartEnd(node);
				if (node.arguments.length >= 2) {
					const arg = node.arguments[1];
					props.withDefaults.arg = _getStartEnd(arg);
				}
				if (ts.isVariableDeclaration(parent)) {
					props.name = getNodeText(ts, parent.name, ast);
				}
			}
			else if (vueCompilerOptions.macros.defineOptions.includes(callText)) {
				if (node.arguments.length && ts.isObjectLiteralExpression(node.arguments[0])) {
					const obj = node.arguments[0];
					ts.forEachChild(obj, node => {
						if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
							const name = getNodeText(ts, node.name, ast);
							if (name === 'inheritAttrs') {
								options.inheritAttrs = getNodeText(ts, node.initializer, ast);
							}
						}
					});
					for (const prop of node.arguments[0].properties) {
						if ((ts.isPropertyAssignment(prop)) && getNodeText(ts, prop.name, ast) === 'name' && ts.isStringLiteral(prop.initializer)) {
							options.name = prop.initializer.text;
						}
					}
				}
			} else if (vueCompilerOptions.macros.templateRef.includes(callText) && node.arguments.length && !node.typeArguments?.length) {
				const define = parseDefineFunction(node);
				define.arg = _getStartEnd(node.arguments[0]);
				let name;
				if (ts.isVariableDeclaration(parent)) {
					name = getNodeText(ts, parent.name, ast);
				}
				templateRefs.push({
					name,
					define
				});
			}
			else if (vueCompilerOptions.composibles.useCssModule.includes(callText)) {
				const module: (typeof cssModules)[number] = {
					exp: _getStartEnd(node)
				};
				if (node.arguments.length) {
					module.arg = _getStartEnd(node.arguments[0]);
				}
				cssModules.push(module);
			}
		}
		ts.forEachChild(node, child => {
			parents.push(node);
			visitNode(child, parents);
			parents.pop();
		});
	}
}

export function parseBindingRanges(ts: typeof import('typescript'), sourceFile: ts.SourceFile) {
	const bindings: TextRange[] = [];
	ts.forEachChild(sourceFile, node => {
		if (ts.isVariableStatement(node)) {
			for (const node_2 of node.declarationList.declarations) {
				const vars = _findBindingVars(node_2.name);
				for (const _var of vars) {
					bindings.push(_var);
				}
			}
		}
		else if (ts.isFunctionDeclaration(node)) {
			if (node.name && ts.isIdentifier(node.name)) {
				bindings.push(_getStartEnd(node.name));
			}
		}
		else if (ts.isClassDeclaration(node)) {
			if (node.name) {
				bindings.push(_getStartEnd(node.name));
			}
		}
		else if (ts.isEnumDeclaration(node)) {
			bindings.push(_getStartEnd(node.name));
		}

		if (ts.isImportDeclaration(node)) {
			if (node.importClause && !node.importClause.isTypeOnly) {
				if (node.importClause.name) {
					bindings.push(_getStartEnd(node.importClause.name));
				}
				if (node.importClause.namedBindings) {
					if (ts.isNamedImports(node.importClause.namedBindings)) {
						for (const element of node.importClause.namedBindings.elements) {
							if (element.isTypeOnly) {
								continue;
							}
							bindings.push(_getStartEnd(element.name));
						}
					}
					else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
						bindings.push(_getStartEnd(node.importClause.namedBindings.name));
					}
				}
			}
		}
	});
	return bindings;
	function _getStartEnd(node: ts.Node) {
		return getStartEnd(ts, node, sourceFile);
	}
	function _findBindingVars(left: ts.BindingName) {
		return findBindingVars(ts, left, sourceFile);
	}
}

export function findBindingVars(ts: typeof import('typescript'), left: ts.BindingName, sourceFile: ts.SourceFile) {
	const vars: TextRange[] = [];
	worker(left);
	return vars;
	function worker(_node: ts.Node) {
		if (ts.isIdentifier(_node)) {
			vars.push(getStartEnd(ts, _node, sourceFile));
		}
		// { ? } = ...
		// [ ? ] = ...
		else if (ts.isObjectBindingPattern(_node) || ts.isArrayBindingPattern(_node)) {
			for (const property of _node.elements) {
				if (ts.isBindingElement(property)) {
					worker(property.name);
				}
			}
		}
		// { foo: ? } = ...
		else if (ts.isPropertyAssignment(_node)) {
			worker(_node.initializer);
		}
		// { foo } = ...
		else if (ts.isShorthandPropertyAssignment(_node)) {
			vars.push(getStartEnd(ts, _node.name, sourceFile));
		}
		// { ...? } = ...
		// [ ...? ] = ...
		else if (ts.isSpreadAssignment(_node) || ts.isSpreadElement(_node)) {
			worker(_node.expression);
		}
	}
}

export function getStartEnd(
	ts: typeof import('typescript'),
	node: ts.Node,
	sourceFile: ts.SourceFile
) {
	return {
		start: (ts as any).getTokenPosOfNode(node, sourceFile) as number,
		end: node.end,
	};
}

export function getNodeText(
	ts: typeof import('typescript'),
	node: ts.Node,
	sourceFile: ts.SourceFile
) {
	const { start, end } = getStartEnd(ts, node, sourceFile);
	return sourceFile.text.substring(start, end);
}
