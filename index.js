'use strict';

const { Command } = require("commander");
const program = new Command();
      program.option("--pwd <dir>","where to run the compiler");
      program.option("--no-warnings","compiler warnings hidden");

const path = require('path');
const fs = require('fs');
const { NodeVM } = require('vm2');
const tmp = require('tmp');
const exec = require('child_process').exec;

const reErr = /\/Repl.hx:([0-9]+): (.*)/;
const reImport = /^(import|using)\s/;
const reIdent = /^[a-z0-9_]+$/;
const reVar = /^var\s([a-z0-9_]+)/;

const WARNING = 'Warning : ';
const LINE = `js.Syntax.code('"<LINE>"');`;
const wrap =
`class Repl {
    static function __init__():Void {
haxe.Log.trace = function(v:Dynamic, ?infos:haxe.PosInfos) {
    untyped console.log(v);
}
var require = untyped require;
${LINE}
<TOKEN>
${LINE}
    }
}`.split('<TOKEN>');

function printCompilerError(stderr) {
    const err  = (stderr || '').split('\n');
    err.forEach(line => {
        const m = reErr.exec(line);
        if (m) {
            const desc = m[2];
            if (desc.indexOf(WARNING) >= 0 && program.opts().warnings) {
              console.log('Repl:', desc.split(WARNING)[1], program.opts().warnings);;
            }
            else {
              console.log('Repl:', desc);
            }
        }
        else if (line !== '') console.log(line);
    });
}

function haxeRepl(extraArgs) {
    program.parse(process.argv);
    if(process.env.DEBUG || true){
      console.log(program.opts());
    }
    console.log(program.args);
    const tmpDir    = tmp.dirSync();
    const tmpClass  = path.join(tmpDir.name, 'Repl.hx');
    const tmpOutput = path.join(tmpDir.name, 'out.js');
    
    const args = (program.args || []).concat([
        '-D', 'js-classic',
        '-D', 'nodejs',
        '-lib', 'hxnodejs',
        '--no-inline',
        '--no-opt',
        '-dce', 'no',
        '-cp', tmpDir.name,
        '-js', tmpOutput,
        'Repl'
    ]).join(' ');
    console.log(args);

    let imports = null;
    let buffer = null;

    return (cmd, context, filename, callback) => {

        // REPL session
        if (!context.__haxe_repl__) {
            context.__haxe_repl__ = true;
            imports = [];
            buffer = [];
        }

        // pre-process input
        if (cmd === undefined) return callback();
        cmd = cmd.trim();
        if (cmd == '$') {
            if (imports.length) console.log(imports.join('\n'));
            else console.log('(no imports)');
            if (buffer.length) console.log(buffer.join('\n'));
            else console.log('(no history)');
            return callback();
        }
        if (cmd === '') return callback();

        let lastOp = 0;
        let retain = null;
        let noLog = false;
        let autoPop = false;
        if (reImport.test(cmd)) {
            if (cmd.charAt(cmd.length - 1) != ';') cmd += ';'; // insert semi
            imports.push(cmd);
            lastOp = 1;
        } else {
            if (reIdent.test(cmd)) retain = cmd;
            if (cmd.substr(0, 6) === '$type(') autoPop = true;
            if (cmd.charAt(cmd.length - 1) != ';') cmd += ';'; // insert semi
            const isVar = reVar.exec(cmd);
            if (isVar) {
                retain = isVar[1];
                noLog = true;
            }
            buffer.push(cmd);
            lastOp = 2;
        }

        // generate Haxe class
        const lines = [].concat(buffer);
        if (retain) {
            let last = lines.pop();
            last += ` untyped js.Syntax.code("{0}", ${retain});`;
            if (noLog) last += ` untyped js.Syntax.code("undefined");`;
            lines.push(last);
        }
        const src = imports.join('\n')
            + wrap.join(
                lines.join(`\n${LINE}\n`)
            );
        fs.writeFileSync(tmpClass, src);

        var pwd = process.cwd();
        if(program.opts().pwd){
          //console.log(program.opts().pwd);
          pwd = program.opts().pwd;
          console.log(pwd); 
        }
        // compile entire code
        exec(`haxe ${args}`, (err, stdout, stderr) => {
            if (err) {
                // compiler error: drop last Haxe instruction
                if (lastOp == 1) {
                    imports.pop();
                } else {
                    buffer.pop();
                }

                printCompilerError(stderr);
                return callback();
            }

            // warnings
            printCompilerError(stderr);

            // extract only new instructions and generate an incremental JS source
            const output = fs.readFileSync(tmpOutput).toString();
            const js = output.split('"<LINE>";\n');
            let result = null;
            const src = js[0] + js.pop() + 'undefined;\n' + (lastOp == 2 ? js.pop() : '');

            // evaluate
            try {
                const vm = new NodeVM({
                  require : {
                    external : true,
                    builtin : ["*"],
                    resolve : (request,options) => {
                      console.log(options);
                      return require.resolve(request, { paths : [pwd,options]});
                    },
                    mock : {
                        events : require("events")
                    }
                  }
                });
                const result = vm.run(src,pwd);
                callback(null, result);
                if (autoPop) {
                    buffer.pop();
                }
            } catch (err) {
                // runtime error: drop last Haxe instruction
                if (lastOp == 1) {
                    imports.pop();
                } else {
                    buffer.pop();
                }
                console.log('Eval:', err.message);
                callback();
            }
        });
    }
}

module.exports = haxeRepl;
