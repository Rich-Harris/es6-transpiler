"use strict";

const assert = require("assert");
const core = require("./core");

function isIdentifier(node) {
	return node && node.type === "Identifier";
}
function isClass(node) {
	return node && (node.type === "ClassDeclaration" || node.type === "ClassExpression")
}

const $defineProperty = "Object.defineProperty";
const objectMixinBody =
		"function(t,s){"
			+ "for(var p in s){"
				+ "if(s.hasOwnProperty(p)){"
					+ "${Object_defineProperty}(t,p,Object.getOwnPropertyDescriptor(s,p));"
				+ "}"
			+ "}"
		+ "return t}"
	;

const classesTranspiler = {
	reset: function() {
		this.__currentClassMethodsStatic = null;
		this.__currentClassName = null;
		this.__superRefName = null;
		this.__protoRefName = null;
		this.__staticRefName = null;
		this.__currentAccessors = null;
		this.__currentStaticAccessors = null;
		this.__currentFirstStaticAccessor = null;

		this.__staticPropertiesCount = 0;
		this.__protoPropertiesCount = 0;
	}

	, createNames: function(node) {
		// We need only one unique name for the entire file

		if( !this.__superRefName ) {
			this.__superRefName = core.unique("super", true);
		}
		if( !this.__protoRefName ) {
			this.__protoRefName = core.unique("$proto", true);
		}
		if( !this.__staticRefName ) {
			this.__staticRefName = core.unique("$static", true);
		}

		this.__DP = core.bubbledVariableDeclaration(node.$scope, "DP", $defineProperty);
		this.__MIXIN = core.bubbledVariableDeclaration(node.$scope, "MIXIN", objectMixinBody.replace("${Object_defineProperty}", this.__DP));
	}

	, setup: function(alter, ast, options) {
		if( !this.__isInit ) {
			this.reset();
			this.__isInit = true;
		}

		this.alter = alter;
	}

	, createPrototypeString: function(node, className, superName, accessors) {
		const accessorsKeys = Object.keys(accessors);

		const accessorsString = accessorsKeys.map(function(key) {
			let accessor = accessors[key];
			let raw = accessor.raw, getter = accessor.get, setter = accessor.set;
			return (raw || key) + ": {" + (getter ? "\"get\": " + getter + ", " : "") + (setter ? "\"set\": " + setter + ", " : "") + "\"configurable\": true, \"enumerable\": true}"
		} ).join(", ");

		let Object_defineProperty_name = core.bubbledVariableDeclaration(node.$scope, "DP", $defineProperty);
		const freezePrototypeString = Object_defineProperty_name + "(" + className + ", \"prototype\", {\"configurable\": false, \"enumerable\": false, \"writable\": false});";

		if ( superName ) {
			return className
				+ ".prototype = Object.create(" + superName + ".prototype"
				+ ", {"
				+ "\"constructor\": {\"value\": " + className + ", \"configurable\": true, \"writable\": true}"
				+ (accessorsString ? ", " + accessorsString : "")
				+ " }"
				+ ");"
				+ freezePrototypeString
			;
		}
		else if ( accessorsString ) {
			return "Object.defineProperties("
				+ className	+ ".prototype, {" + accessorsString + "});"
				+ freezePrototypeString
			;
		}
		else {
			return freezePrototypeString;
		}
	}

	, createStaticAccessorsDefinitionString: function(node, recipientStr, accessors) {
		let accessorsKeys = Object.keys(accessors);

		if ( !accessorsKeys.length ) {
			return "";
		}

		return ";Object.defineProperties(" + recipientStr + ", {" + accessorsKeys.map(function(key) {
			let accessor = accessors[key];
			let raw = accessor.raw, getter = accessor.get, setter = accessor.set;
			return (raw || key) + ": {" + (getter ? "\"get\": " + getter + ", " : "") + (setter ? "\"set\": " + setter : "") + ", \"configurable\": true, \"enumerable\": true}"
		} ).join(", ") + "});";
	}

	, ':: ClassDeclaration, ClassExpression': function replaceClassBody(node, astQuery) {
		{
			this.createNames(node);

			const isClassExpression = node.type === 'ClassExpression'
				, nodeId = node.id
			;

			assert(nodeId ? isIdentifier(nodeId) : isClassExpression);

			const classBodyNodes = node.body.body
				, currentClassName = nodeId ? nodeId.name : core.unique("constructor", true)
				, SUPER_NAME = this.__superRefName
				, useStrictString = node.strictMode ? "" : "\"use strict\";"
			;

			let superClass = node.superClass
				, classBodyNodesCount = classBodyNodes.length
				, insertAfterBodyBegin_string = ""
				, classConstructor
				, extendedClassConstructorPostfix
			;

			let objectMixinFunctionName = this.__MIXIN;

			node["$ClassName"] = currentClassName;
			this.__currentClassName = currentClassName;

			let classStr = (isClassExpression ? "(" : "var " + currentClassName + " = ")
				+ "(function("
			;

			if( superClass ) {
				classStr += SUPER_NAME;
				superClass = isIdentifier(superClass) ? superClass.name : this.alter.get(superClass.range[0], superClass.range[1]);

				insertAfterBodyBegin_string = objectMixinFunctionName + "(" + currentClassName + ", " + SUPER_NAME + ");";
			}

			classStr += ")";

			for( let i = 0 ; i < classBodyNodesCount && !classConstructor ; i++ ) {
				classConstructor = classBodyNodes[i];
				if( classConstructor.type !== "MethodDefinition" ) {
					classConstructor = null;
				}
				else if( classConstructor.key.name !== "constructor" ) {
					classConstructor = null;
				}
			}

			if ( useStrictString ) {
				this.alter.replace(node.body.range[0], node.body.range[0] + 1, '{' + useStrictString);
			}

			this.__currentAccessors = {};
			this.__currentStaticAccessors = {};
			if( classBodyNodesCount ) {
				for ( let i = 0 ; i < classBodyNodesCount ; i++ ) {
					this.replaceClassMethods(classBodyNodes[i], astQuery);
				}
			}

			extendedClassConstructorPostfix = this.createPrototypeString(node, currentClassName, superClass && SUPER_NAME, this.__currentAccessors);
			let staticAccessorsDefinitionString = this.createStaticAccessorsDefinitionString(node, currentClassName, this.__currentStaticAccessors);

			if( classConstructor ) {
				this.alter.replace(classConstructor.key.range[0], classConstructor.key.range[1], "function " + currentClassName);
				if( extendedClassConstructorPostfix ) {
					this.alter.insert(classConstructor.range[1], extendedClassConstructorPostfix);
				}

				astQuery.traverse(classConstructor, this.replaceClassConstructorSuper);
				astQuery.traverse(classConstructor, this.replaceClassMethodSuperInConstructor);
			}
			else {
				insertAfterBodyBegin_string =  "function " + currentClassName + "() {"
					+ (superClass ? SUPER_NAME + ".apply(this, arguments)" : "")
					+ "}" + (insertAfterBodyBegin_string || "") + (extendedClassConstructorPostfix || "");
			}

			let theEndString = '', tmpVars = [];
			if ( this.__staticPropertiesCount ) {
				theEndString += (objectMixinFunctionName + '(' + currentClassName + ',' + this.__staticRefName + ');')
				tmpVars.push(this.__staticRefName);
			}
			if ( this.__protoPropertiesCount ) {
				theEndString += (objectMixinFunctionName + '(' + currentClassName + '.prototype,' + this.__protoRefName + ');')
				tmpVars.push(this.__protoRefName);
			}
			if ( tmpVars.length ) {
				insertAfterBodyBegin_string += ('var ' + tmpVars.join('={},') + '={};');
				tmpVars.push('void 0');
			}
			theEndString += tmpVars.join('=');

			this.alter.insertBefore(node.body.range[0] + 1, insertAfterBodyBegin_string);

			if ( staticAccessorsDefinitionString ) {
				this.alter.insertAfter(this.__currentFirstStaticAccessor.range[1], staticAccessorsDefinitionString);
			}

			// replace class definition
			// text change 'class A[ extends B]' => 'var A = (function([super$0])'
			this.alter.replace(node.range[0], node.body.range[0], classStr);

			this.alter.insert(node.range[1] - 1, theEndString + ";return " + currentClassName + ";");

			this.alter.insert(node.range[1],
				")(" + (superClass || "") + ")"
				+ (isClassExpression ? ")" : ";")//tail ')' or semicolon
			);

			this.__currentClassName = null;
			this.__staticPropertiesCount = 0;
			this.__protoPropertiesCount = 0;
		}
	}

	, unwrapSuperCall: function unwrapSuperCall(node, calleeNode, isStatic, property, isConstructor) {
		let superRefName = this.__superRefName;
		assert(superRefName);

		let changeStr = superRefName + (isStatic ? "" : ".prototype");
		let callArguments = node.arguments;
		let hasSpreadElement = !isStatic && callArguments.some(function(node){ return node.type === "SpreadElement" });

		let changesEnd;
		if( (!isStatic || isConstructor) && !hasSpreadElement ) {
			changeStr += (property ? "." + property.name : "");

			if( !callArguments.length ) {
				changeStr += ".call(this)";
				changesEnd = node.range[1];
			}
			else {
				changeStr += ".call(this, ";
				changesEnd = callArguments[0].range[0];
			}
		}
		else {
			changesEnd = calleeNode.range[1];
		}

		// text change 'super(<some>)' => 'super$0(<some>)' (if <some> contains SpreadElement) or 'super$0.call(this, <some>)'
		this.alter.replace(calleeNode.range[0], changesEnd, changeStr);
	}
	
	, replaceClassConstructorSuper: function replaceClassConstructorSuper(node) {
		if( node.type === "CallExpression" ) {
			let calleeNode = node.callee;

			if( calleeNode && isIdentifier(calleeNode) && calleeNode.name === "super" ) {
				this.unwrapSuperCall(node, calleeNode, true, null, true);
			}
		}
		else if( isClass(node) ) {
			return false;
		}
	}
	
	, replaceClassMethods: function replaceClassMethods(node, astQuery) {
		if( node.type === "MethodDefinition" && node.key.name !== "constructor" ) {
			let isStatic = this.__currentClassMethodsStatic = node.static;
			let isComputed = node.computed;

			let nodeKey = node.key;
			let keyRange = isComputed ? nodeKey.bracesRange : nodeKey.range;

			if( node.kind === "set" || node.kind === "get" ) {
				if ( isComputed ) {
					let targetName = isStatic === true ? this.__currentClassName : this.__currentClassName + '.prototype';

					// get [<name>]() -> DP$0(<className>.prototype,<name>,
					this.alter.replace(node.range[0], nodeKey.bracesRange[0] + 1, this.__DP + '(' + targetName + ',');
					this.alter.replace(nodeKey.range[1], nodeKey.bracesRange[1], ',{"' + node.kind + '":function');

					let nodeValue = node.value;
					this.alter.insertAfter(nodeValue.range[1], ',"configurable":true,"enumerable":true});');
				}
				else {// TODO:: make is easiest
					if ( isStatic && !this.__currentFirstStaticAccessor ) {
						this.__currentFirstStaticAccessor = node;
					}

					let isLiteral = nodeKey.type == 'Literal';
					assert(isIdentifier(nodeKey) || isLiteral);

					let name;
					if ( isLiteral ) {
						name = nodeKey.value;
					}
					else {
						name = nodeKey.name;
					}

					let accessor = isStatic === true
						? this.__currentStaticAccessors[name] || (this.__currentStaticAccessors[name] = {})
						: this.__currentAccessors[name] || (this.__currentAccessors[name] = {})
					;
					let replacement = accessor[node.kind] = core.unique((isStatic ? "static_" : "") + name + "$" + node.kind, true);

					if ( isLiteral ) {
						accessor.raw = nodeKey.raw;
					}

					this.alter.replace(node.range[0], nodeKey.range[1], "function " + replacement);
				}

			}
			else {
				if ( isStatic ) {
					this.__staticPropertiesCount++;
				}
				else {
					this.__protoPropertiesCount++;
				}

				let targetName = isStatic === true ? this.__staticRefName : this.__protoRefName;

				if ( isStatic ) {
					// text change 'static method(<something>)' => '$static$0.method(<something>)'
					// text change 'static [method](<something>)' => '$static$0[method](<something>)'
					this.alter.replace(node.range[0], keyRange[0], targetName + (isComputed ? '' : '.'));
				}
				else {
					// text change 'method(<something>)' => '$proto$0.method(<something>)'
					// text change '[method](<something>)' => '$proto$0[method](<something>)'
					this.alter.insert(node.range[0], targetName + (isComputed ? '' : '.'));
				}

				// text change 'method(<something>)' => 'method = function(<something>)', '[method](<something>)' => '[method] = function(<something>)'
				this.alter.insert(keyRange[1], " = function");

				this.alter.insertBefore(node.range[1], ';', {extend: true});
			}

			astQuery.traverse(node.value, this.replaceClassMethodSuper);
		}
		this.__currentClassMethodsStatic = null;
	}
	
	, replaceClassMethodSuper: function replaceClassMethodSuper(node) {
		if( node.type === "CallExpression" ) {
			assert(typeof this.__currentClassMethodsStatic === "boolean");

			let calleeNode = node.callee;

			if( calleeNode && calleeNode.type === "MemberExpression" ) {
				let objectNode = calleeNode.object;
				if( objectNode && isIdentifier(objectNode) && objectNode.name === "super" ) {
					// text change 'super.method(<some>)' => 'super$0(<some>)' (if <some> contains SpreadElement) or 'super$0.call(this, <some>)'
					this.unwrapSuperCall(node, objectNode, this.__currentClassMethodsStatic, calleeNode.property);
				}
			}
		}
		else if( isClass(node) ) {
			return false;
		}
	}

	, replaceClassMethodSuperInConstructor: function replaceClassMethodSuperInConstructor(node) {
		if( isIdentifier(node) && node.name === "super" ) {
			let parent = node.$parent;
			if ( parent.type === 'CallExpression' ) {
				//'super(<some>)' case
				return;
			}
			// TODO:: using letConts transpiler for renaming

			// text change 'super.a(<some>)' => 'super$0.a(<some>)'
			this.alter.replace(node.range[0], node.range[1], this.__superRefName);
		}
		else if( isClass(node) ) {
			return false;
		}
	}
};

for(let i in classesTranspiler) if( classesTranspiler.hasOwnProperty(i) && typeof classesTranspiler[i] === "function" ) {
	classesTranspiler[i] = classesTranspiler[i].bind(classesTranspiler);
}

module.exports = classesTranspiler;
