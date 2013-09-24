"use strict";

const assert = require("assert");
const is = require("simple-is");
const stringset = require("stringset");
const traverse = require("./../lib/traverse");
const jshint_vars = require("./../jshint_globals/vars.js");
const Scope = require("./../lib/scope");
const error = require("./../lib/error");

function getline(node) {
	return node.loc.start.line;
}

function isConstLet(kind) {
	return kind === "const" || kind === "let";
}

function isVarConstLet(kind) {
	return kind === "var" || kind === "const" || kind === "let";
}

function isFunction(node) {
	const type = node.type;
	return type === "FunctionDeclaration" || type === "FunctionExpression" || type === "ArrowFunctionExpression";
}

function isNonFunctionBlock(node) {
	return node.type === "BlockStatement" && !isFunction(node.$parent.type);
}

function isForWithConstLet(node) {
	return node.type === "ForStatement" && node.init && node.init.type === "VariableDeclaration" && isConstLet(node.init.kind);
}

function isForInWithConstLet(node) {
	return node.type === "ForInStatement" && node.left.type === "VariableDeclaration" && isConstLet(node.left.kind);
}

function isLoop(node) {
	const type = node.type;
	return type === "ForStatement" || type === "ForInStatement" || type === "WhileStatement" || type === "DoWhileStatement";
}

function isReference(node) {
	const parent = node.$parent;
	const parentType = parent && parent.type;

	return node.$refToScope
		|| node.type === "Identifier"
			&& !(parentType === "VariableDeclarator" && parent.id === node) // var|let|const $
			&& !(parentType === "MemberExpression" && parent.computed === false && parent.property === node) // obj.$
			&& !(parentType === "Property" && parent.key === node) // {$: ...}
			&& !(parentType === "LabeledStatement" && parent.label === node) // $: ...
			&& !(parentType === "CatchClause" && parent.param === node) // catch($)
			&& !(isFunction(parent) && parent.id === node) // function $(..
			&& !(isFunction(parent) && parent.params.indexOf(node) !== -1) // function f($)..
			&& true
	;
}

function isLvalue(node) {
	return isReference(node) &&
		(
			(node.$parent.type === "AssignmentExpression" && node.$parent.left === node)
			|| (node.$parent.type === "UpdateExpression" && node.$parent.argument === node)
		)
	;
}

function isObjectPattern(node) {
	return node && node.type === 'ObjectPattern';
}

function isArrayPattern(node) {
	return node && node.type === 'ArrayPattern';
}

let UUID_PREFIX = "uuid" + ((Math.random() * 1e6) | 0);
let UUID = 1;

let core = module.exports = {
	traverse: traverse,

	reset: function() {
		this.allIdentifiers = stringset();

		this.outermostLoop = null;
		this.functions = [];
		this.bubbledVariables = {}
	}

	, setup: function(alter, ast, options, src) {
		if( !this.__isInit ) {
			this.reset();
			this.__isInit = true;
		}

		this.alter = alter;
		this.src = src;
		this.options = options;
	}

	, pre: function(ast) {
		// setup scopes
		traverse(ast, {pre: this.createScopes});
		const topScope = this.createTopScope(ast.$scope, this.options.environments, this.options.globals);

		// allIdentifiers contains all declared and referenced vars
		// collect all declaration names (including those in topScope)
		const allIdentifiers = this.allIdentifiers;
		topScope.traverse({pre: function(scope) {
			allIdentifiers.addMany(scope.decls.keys());
		}});

		// setup node.$refToScope, check for errors.
		// also collects all referenced names to allIdentifiers
		traverse(ast, {pre: this.setupReferences});

		// static analysis passes
		traverse(ast, {pre: this.detectConstAssignment});

		return false;
	}

	, unique: function (name, newVariable, additionalFilter) {
		assert(newVariable || this.allIdentifiers.has(name));

		for( let cnt = 0 ; ; cnt++ ) {
			const genName = name + "$" + cnt;
			if( !this.allIdentifiers.has(genName) && (!additionalFilter || !additionalFilter.has(genName))) {
				if( newVariable ) {
					this.allIdentifiers.add(genName);
				}
				return genName;
			}
		}
	}

	, uniqueByToken: function (token, name, newVariable, additionalFilter) {
		if( this.__nameByToken && token in this.__nameByToken ) {
			return this.__nameByToken[token];
		}

		if( !this.__nameByToken ) {
			this.__nameByToken = {};
		}

		return this.__nameByToken[token] = this.unique(name, newVariable, additionalFilter);
	}

	, createScopes: function (node, parent) {
		assert(!node.$scope);

		node.$parent = parent;
		node.$scope = node.$parent ? node.$parent.$scope : null; // may be overridden

		function addParamToScope(param) {
			if( param === null ){
				return;
			}

			if( isObjectPattern(param) ) {
				param.properties.forEach(addParamToScope);
			}
			else if( param.type === "Property" ) {//from objectPattern
				addParamToScope(param.value);
			}
			else if( isArrayPattern(param) ) {
				param.elements.forEach(addParamToScope);
			}
			else {
				node.$scope.add(param.name, "param", param, null);
			}
		}

		function addVariableToScope(variable, kind, originalDeclarator) {
			if( isObjectPattern(variable) ) {
				variable.properties.forEach(function(variable) {
					addVariableToScope(variable, kind, originalDeclarator);
				});
			}
			else if( variable.type === "Property" ) {//from objectPattern
				addVariableToScope(variable.value, kind, originalDeclarator);
			}
			else if( isArrayPattern(variable) ) {
				variable.elements.forEach(function(variable) {
					if( variable ) {
						addVariableToScope(variable, kind, originalDeclarator);
					}
				});
			}
			else if( variable.type === "SpreadElement" ) {//from arrayPattern
				node.$scope.add(variable.argument.name, kind, variable, variable.range[1], originalDeclarator);
			}
			else {
				node.$scope.add(variable.name, kind, variable, variable.range[1], originalDeclarator);
			}
		}

		if (node.type === "Program") {
			// Top-level program is a scope
			// There's no block-scope under it
			node.$scope = new Scope({
				kind: "hoist",
				node: node,
				parent: null
			});

			/* Due classBodyReplace is separate process, we do not really need this check
			 } else if (node.type === "ClassDeclaration") {
			 assert(node.id.type === "Identifier");

			 node.$parent.$scope.add(node.id.name, "fun", node.id, null);
			 */
		} else if (isFunction(node)) {
			// Function is a scope, with params in it
			// There's no block-scope under it
			// Function name goes in parent scope
			if (node.id) {
	//            if (node.type === "FunctionExpression") {
	//                console.dir(node.id);
	//            }
	//            assert(node.type === "FunctionDeclaration"); // no support for named function expressions yet

				assert(node.id.type === "Identifier");
				node.$parent.$scope.add(node.id.name, "fun", node.id, null);
			}

			node.$scope = new Scope({
				kind: "hoist",
				node: node,
				parent: node.$parent.$scope
			});

			node.params.forEach(addParamToScope);

		} else if (node.type === "VariableDeclaration") {
			// Variable declarations names goes in current scope
			assert(isVarConstLet(node.kind));
			node.declarations.forEach(function(declarator) {
				assert(declarator.type === "VariableDeclarator");

				if (this.options.disallowVars && node.kind === "var") {
					error(getline(declarator), "var {0} is not allowed (use let or const)", name);
				}

				addVariableToScope(declarator.id, node.kind, declarator);
			}, this);

		} else if (isForWithConstLet(node) || isForInWithConstLet(node)) {
			// For(In) loop with const|let declaration is a scope, with declaration in it
			// There may be a block-scope under it
			node.$scope = new Scope({
				kind: "block",
				node: node,
				parent: node.$parent.$scope
			});

		} else if (isNonFunctionBlock(node)) {
			// A block node is a scope unless parent is a function
			node.$scope = new Scope({
				kind: "block",
				node: node,
				parent: node.$parent.$scope
			});

		} else if (node.type === "CatchClause") {
			const identifier = node.param;

			node.$scope = new Scope({
				kind: "catch-block",
				node: node,
				parent: node.$parent.$scope
			});
			node.$scope.add(identifier.name, "caught", identifier, null);

			// All hoist-scope keeps track of which variables that are propagated through,
			// i.e. an reference inside the scope points to a declaration outside the scope.
			// This is used to mark "taint" the name since adding a new variable in the scope,
			// with a propagated name, would change the meaning of the existing references.
			//
			// catch(e) is special because even though e is a variable in its own scope,
			// we want to make sure that catch(e){let e} is never transformed to
			// catch(e){var e} (but rather var e$0). For that reason we taint the use of e
			// in the closest hoist-scope, i.e. where var e$0 belongs.
			node.$scope.closestHoistScope().markPropagates(identifier.name);
		}
		else if ( node.type === "ThisExpression" ) {
			let thisFunctionScope = node.$scope.closestHoistScope(), functionNode = thisFunctionScope.node;

			if( functionNode.type === "ArrowFunctionExpression" ) {
				do {
					// ArrowFunction should transpile to the function with .bind(this) at the end
					thisFunctionScope.markThisUsing();
				}
				while(
					(functionNode = thisFunctionScope.node.$parent)
						&& functionNode.type === "ArrowFunctionExpression"
						&& (thisFunctionScope = functionNode.$scope.closestHoistScope())
					);
			}
		}
	}

	, createTopScope: function(programScope, environments, globals) {
		function inject(obj) {
			for (let name in obj) {
				const writeable = obj[name];
				const kind = (writeable ? "var" : "const");
				if (topScope.hasOwn(name)) {
					topScope.remove(name);
				}
				topScope.add(name, kind, {loc: {start: {line: -1}}}, -1);
			}
		}

		const topScope = new Scope({
			kind: "hoist",
			node: {},
			parent: null
		});

		const complementary = {
			undefined: false,
			Infinity: false,
			console: false
		};

		inject(complementary);
		inject(jshint_vars.reservedVars);
		inject(jshint_vars.ecmaIdentifiers);
		if (environments) {
			environments.forEach(function(env) {
				if (!jshint_vars[env]) {
					error(-1, 'environment "{0}" not found', env);
				} else {
					inject(jshint_vars[env]);
				}
			});
		}
		if (globals) {
			inject(globals);
		}

		// link it in
		programScope.parent = topScope;
		topScope.children.push(programScope);

		return topScope;
	}

	/**
	 * traverse: pre
	 */
	, setupReferences: function(node) {
		if (isReference(node)) {
			this.allIdentifiers.add(node.name);

			const scope = node.$scope.lookup(node.name);
			if (!scope && this.options.disallowUnknownReferences) {
				error(getline(node), "reference to unknown global variable {0}", node.name);
			}
			// check const and let for referenced-before-declaration
			let kind;
			if (scope && ((kind = scope.getKind(node.name)) === "const" || kind === "let")) {
				const allowedFromPos = scope.getFromPos(node.name);
				const referencedAtPos = node.range[0];
				assert(is.finitenumber(allowedFromPos));
				assert(is.finitenumber(referencedAtPos));
				if (referencedAtPos < allowedFromPos) {
					if (!node.$scope.hasFunctionScopeBetween(scope)) {
						error(getline(node), "{0} is referenced before its declaration", node.name);
					}
				}
			}
			node.$refToScope = scope;
		}
	}

	, detectLoopClosuresPre: function detectLoopClosuresPre(node) {
		if (this.outermostLoop === null && isLoop(node)) {
			this.outermostLoop = node;
		}
		if (!this.outermostLoop) {
			// not inside loop
			return;
		}

		// collect function-chain (as long as we're inside a loop)
		if (isFunction(node)) {
			this.functions.push(node);
		}
		if (this.functions.length === 0) {
			// not inside function
			return;
		}

		if (isReference(node) && isConstLet(node.$refToScope.getKind(node.name))) {
			let n = node.$refToScope.node;

			// node is an identifier
			// scope refers to the scope where the variable is defined
			// loop ..-> function ..-> node

			let ok = true;
			while (n) {
//            n.print();
//            console.log("--");
				if (n === this.functions[this.functions.length - 1]) {
					// we're ok (function-local)
					break;
				}
				if (n === this.outermostLoop) {
					// not ok (between loop and function)
					ok = false;
					break;
				}
//            console.log("# " + scope.node.type);
				n = n.$parent;
//            console.log("# " + scope.node);
			}
			if (ok) {
//            console.log("ok loop + closure: " + node.name);
			} else {
				error(getline(node), "can't transform closure. {0} is defined outside closure, inside loop", node.name);
			}


			/*
			 walk the scopes, starting from innermostFunction, ending at this.outermostLoop
			 if the referenced scope is somewhere in-between, then we have an issue
			 if the referenced scope is inside innermostFunction, then no problem (function-local const|let)
			 if the referenced scope is outside this.outermostLoop, then no problem (const|let external to the loop)

			 */
		}
	}

	, detectLoopClosuresPost: function detectLoopClosuresPost(node) {
		if (this.outermostLoop === node) {
			this.outermostLoop = null;
		}
		if (isFunction(node)) {
			this.functions.pop();
		}
	}

	, detectConstAssignment: function detectConstAssignment(node) {
		if (isLvalue(node)) {
			const scope = node.$scope.lookup(node.name);
			if (scope && scope.getKind(node.name) === "const") {
				error(getline(node), "can't assign to const variable {0}", node.name);
			}
		}
	}

	, getNodeVariableNames: function(node) {
		let vars = [];

		function addParam(param) {
			if( param === null ){
				return;
			}

			if( isObjectPattern(param) ) {
				param.properties.forEach(addParam);
			}
			else if( param.type === "Property" ) {//from objectPattern
				addParam(param.value);
			}
			else if( isArrayPattern(param) ) {
				param.elements.forEach(addParam);
			}
			else {
				vars.push(param.name);
			}
		}

		function addVariable(variable) {
			if( !variable ) {
				return;
			}

			if( isObjectPattern(variable) ) {
				variable.properties.forEach(addVariable);
			}
			else if( variable.type === "Property" ) {//from objectPattern
				addVariable(variable.value);
			}
			else if( isArrayPattern(variable) ) {
				variable.elements.forEach(addVariable);
			}
			else if( variable.type === "SpreadElement" ) {//from arrayPattern
				vars.push(variable.argument.name);
			}
			else {
				vars.push(variable.name);
			}
		}

		if( isFunction(node) ) {
			node.params.forEach(addParam);
		}
		else if( node.type === "VariableDeclaration" ) {
			node.declarations.forEach(function(declarator) {
				addVariable(declarator.id);
			}, this);
		}
		else if( node.type === "AssignmentExpression" ) {
			addVariable(node.left)
		}
		else {
			addVariable(node)
		}

		return vars;
	}

	, PropertyToString: function PropertyToString(node) {
		assert(node.type === "Literal" || node.type === "Identifier");

		var result;
		if( node.type === "Literal" ) {
			result = "[" + node.raw + "]";
		}
		else {
			result = "." + node.name;
		}

		return result
	}

	,
	/**
	 *
	 * @param {Object} node
	 * @param {string} donor
	 * @param {number} fromIndex
	 */
	unwrapSpreadDeclaration: function(node, donor, fromIndex) {
		assert(node.type === "Identifier");

		const sliceFunctionName = this.bubbledVariableDeclaration(node.$scope, "SLICE", "Array.prototype.slice");

		return node.name + " = " + sliceFunctionName + ".call(" + donor + ", " + fromIndex + ")";
	}


	,
	/**
	 * TODO:: update this method to unwrapp more node types
	 * @param {Object} node
	 */
	unwrapNode: function(node) {
		assert(typeof node === "object");
		var from = node.range[0], to = node.range[1];

		if( node.type === "SequenceExpression" )return "(" + this.alter.get(from, to) + ")";
		if( node.type === "ConditionalExpression" )return "(" + this.alter.get(from, to) + ")";
		return this.alter.get(from, to);
	}

	,
	/**
	 *
	 * @param {Object} node
	 * @param {string} donor
	 * @param {string} value
	 */
	definitionWithDefaultString: function(node, donor, value) {
		assert(node.type === "Identifier");

		return node.name + " = " + donor + ";" + this.defaultString(node, value);
	}

	,
	/**
	 *
	 * @param {Object} node
	 * @param {string} value
	 */
	defaultString: function(node, value) {
		assert(node.type === "Identifier");

		return "if(" + node.name + " === void 0)" + node.name + " = " + value;
	}

	,

	__assignmentString: function(node, isDeclaration) {
		assert(node.type === "AssignmentExpression" || node.type === "VariableDeclarator");

		let left, right, isAssignmentExpression = node.type === "AssignmentExpression";

		if( isAssignmentExpression ) {
			left = node.left;
			right = node.right;
		}
		else {
			left = node.id;
			right = node.init;
		}

		let destructuringDefaultNode = left.default;//TODO:: goes to latest Parser API from esprima

		let variableName = left.name;
		let result = variableName + " = ";
		let valueString = right["object"].name + core.PropertyToString(right["property"]);

		if( isAssignmentExpression ) {
			result += "(";
		}

		if( typeof destructuringDefaultNode === "object" ) {
//			let tempVar = core.getScopeTempVar(node.$scope);
//
//			result += (
//				"((" + tempVar + " = " + valueString + ") === void 0 ? " + this.alter.get(destructuringDefaultNode.range[0], destructuringDefaultNode.range[1]) + " : " + tempVar + ")"
//			);
//
//			core.setScopeTempVar(node.$scope, tempVar);

			// TODO:: tests
			result += (
				"((" + variableName + " = " + valueString + ") === void 0 ? " + this.alter.get(destructuringDefaultNode.range[0], destructuringDefaultNode.range[1]) + " : " + variableName + ")"
				);
		}
		else {
			result += valueString;
		}

		if( isAssignmentExpression ) {
			result += ", " + left.name + ")";
		}

		return result;
	}

	,
	AssignmentExpressionString: function(expression) {
		return this.__assignmentString(expression, false);
	}

	,
	VariableDeclaratorString: function(definition) {
		return this.__assignmentString(definition, true);
	}

	, __getNodeBegin: function(node) {
		let begin;
		let hoistScopeNodeBody = node.body;

		if( node.type === "Program" ) {
			begin = 0;
		}
		else if( node.type === "ArrowFunctionExpression" ) {
			begin = hoistScopeNodeBody.range[0];
		}
		else {
			if( hoistScopeNodeBody.length ) {
				hoistScopeNodeBody = hoistScopeNodeBody[0];
			}
			begin = hoistScopeNodeBody.range[0];

			if( isFunction(node) ) {
				begin++;
			}
		}

		return begin;
	}

	, getScopeTempVar: function(scope) {
		assert(scope instanceof Scope, scope + " is not instance of Scope");

		scope = scope.closestHoistScope();

		var freeVar = scope.popFree();

		if( !freeVar ) {
			freeVar = core.unique("$D", true);
			this.createScopeVariableDeclaration(scope, "var", freeVar);

			this.alter.insert(this.__getNodeBegin(scope.node), "var " + freeVar + ";");
		}
		/*newDefinitions.push({
			"type": "EmptyStatement"
			, __semicolon: true
		});
		newDefinitions.push({
			"type": "AssignmentExpression"
			, "operator": "="
			, "left": {
				"type": "Identifier",
				"name": valueIdentifierName
			}
			, "right": {
				"type": "__Raw",
				__initValue: valueIdentifierDefinition
			}
		});*/

		return freeVar;
	}

	, setScopeTempVar: function(scope, freeVar) {
		assert(scope instanceof Scope, scope + " is not instance of Scope");
		assert(typeof freeVar === "string");

		scope = scope.closestHoistScope();

		scope.pushFree(freeVar);
	}

	, findParentForScopes: function() {
		let parentScope
			, scopes = [].slice.call(arguments)
			, scopesLength = scopes.length
			, maxCounter = 0
		;

		assert(scopesLength);

		if( scopesLength.length === 1 ) {
			return scopes[0].closestHoistScope();
		}

		for( let i = 0 ; i < scopesLength ; ++i ) {
			let scope = scopes[i];
			scope = scopes[i] = scope.closestHoistScope();

			if( scope.node.type === "Program" ) {
				return scope;
			}
		}

		let uniquePathId = UUID_PREFIX + UUID++;

		while( !parentScope && scopesLength && ++maxCounter < 1000 ) {
			for( let i = 0 ; i < scopesLength ; ++i ) {
				let scope = scopes[i];

				let hoistScope = scope.closestHoistScope();

				if( hoistScope === scope ) {
					scope = scope.parent;
				}

				if( hoistScope.$__path === uniquePathId ) {
					parentScope = hoistScope;
					break;
				}

				if( scope ) {
					hoistScope.$__path = uniquePathId;
					scopes[i] = scope;
				}
				else {
					scopesLength--;
					i--;
					scopes.splice(i, 1);
				}
			}
		}

		assert(!!parentScope);

		return parentScope;
	}

	, createScopeVariableDeclaration: function(scope, kind, variableName, parentNode) {
		scope.add(variableName, kind, {
			//TODO:
		});
	}

	, bubbledVariableDeclaration: function(scope, variableName, variableInitValue, isFunction) {
		scope = scope.closestHoistScope();

		let bubbledVariable = this.__isBubbledVariableDeclaration(variableName, variableInitValue);

		if( bubbledVariable ) {
			if( scope.lookup(bubbledVariable.name) ) {
				return bubbledVariable.name;
			}

			scope = this.findParentForScopes(scope, bubbledVariable.scope);
			return this.__rebaseBubbledVariableDeclaration(scope, variableName);
		}
		else {
			return this.__createBubbledVariableDeclaration(scope, variableName, variableInitValue, isFunction);
		}
	}

	, __isBubbledVariableDeclaration: function(variableName, variableInitValue) {
		let bubbledVariable = this.bubbledVariables[variableName];

		if( bubbledVariable && bubbledVariable.value === variableInitValue ) {
			return bubbledVariable;
		}
		return false;
	}

	, __createBubbledVariableDeclaration: function(scope, variableName, variableInitValue, isFunction, bubbledVariable) {
		if( bubbledVariable ) {
			isFunction = bubbledVariable.isFunction;
			variableName = bubbledVariable.name;
			variableInitValue = bubbledVariable.value;

			bubbledVariable.scope = scope;//rebase to the new scope
			bubbledVariable.changesOptions = {};//create new options for new changes
		}
		else {
			bubbledVariable = {
				name: core.unique(variableName, true)
				, value: variableInitValue
				, isFunction: isFunction
				, scope: scope
				, changesOptions: {}
			};
			this.bubbledVariables[variableName] = bubbledVariable;
			variableName = bubbledVariable.name;
		}

		// remove previous VariableDeclaration ?
		this.createScopeVariableDeclaration(scope, "var", variableName);

		if( isFunction ) {
			variableInitValue = "function " + variableName + variableInitValue
		}
		else {
			variableInitValue = "var " + variableName + " = " + variableInitValue + ";";
		}

		this.alter.insert(this.__getNodeBegin(scope.node), variableInitValue, bubbledVariable.changesOptions);

		return variableName;
	}

	, __rebaseBubbledVariableDeclaration: function(scope, variableName) {
		let bubbledVariable = this.bubbledVariables[variableName];
		let latestChangesOptions = bubbledVariable.changesOptions;

		latestChangesOptions.inactive = true;//deactivate this changes

		return this.__createBubbledVariableDeclaration(scope, void 0, void 0, void 0, bubbledVariable);
	}
};

for(let i in core) if( core.hasOwnProperty(i) && typeof core[i] === "function" ) {
	core[i] = core[i].bind(core);
}
