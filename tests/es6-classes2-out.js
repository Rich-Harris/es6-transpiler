var ASSIGN$0 = Object['assign']||function(t,s){for(var p in s){if(s.hasOwnProperty(p)){t[p]=s[p];}}return t};var class1 = (function(){
    function class1(msg) {
        this.property1 = msg;
    }
    class1.sayStatic = function() { return "[static:class1]" }

    class1.prototype.say = function() { return "class1:" + this.property1 }
;return class1;})();

var super$0;

var class2 = (function(super$1){ASSIGN$0(class2, super$1);
    class2.sayStatic = function(){ return super$1.sayStatic() + "[static:class2]" }

    //static A = 123;

    function class2(message) {var message = (message).message;
        super$0 = "test_super";//super variable test
        super$1.call(this, message);
        this.property2 = message;
    }class2.prototype = Object.create(super$1.prototype, {"constructor": {"value": class2, "configurable": true, "writable": true, "enumerable": false} });

    class2.prototype.say = function() {var a = arguments[0];if(a === void 0)a = 1;var b = (arguments[1] !== void 0 ? arguments[1] : [2])[0];
        return super$1.prototype.say.call(this) + "|class2" + ":" + this.property2 + "|" + a + "|" + b + ":" + class2.sayStatic();
    }
;return class2;})(class1);

var class3 = (function(super$1){function class3() {return super$1.apply(this, arguments)}ASSIGN$0(class3, super$1);class3.prototype = Object.create(super$1.prototype, {"constructor": {"value": class3, "configurable": true, "writable": true, "enumerable": false} });      class3.prototype.say = function(){return "class3"}
;return class3;})(class1);

//console.log(class2.A === 123);
console.log((new class2({message: "test"})).say() === "class1:test|class2:test|1|2:[static:class1][static:class2]")
console.log((new class3()).say() === "class3")
console.log(super$0 === "test_super")

