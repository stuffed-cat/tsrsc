import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

/**
 * AST分析选项配置
 * 用于控制AST输出的详细程度和格式
 */
export interface AstAnalysisOptions {
  showText?: boolean;      // 是否显示节点文本内容
  showTypes?: boolean;     // 是否显示类型信息
  showSymbols?: boolean;   // 是否显示符号信息
  maxTextLength?: number;  // 文本显示的最大长度
}

/**
 * 函数信息接口
 * 包含函数的基本元数据
 */
export interface FunctionInfo {
  name: string;           // 函数名称
  signature: string;      // 函数签名
  parameters: Array<{     // 参数列表
    name: string;         // 参数名
    type: string;         // 参数类型
  }>;
  returnType: string;     // 返回值类型
}

/**
 * TypeScript AST分析器
 * 提供对TypeScript源码的抽象语法树分析功能
 */
export class TypeScriptAstAnalyzer {
  private program: ts.Program;        // TypeScript程序实例
  private typeChecker: ts.TypeChecker; // 类型检查器
  private sourceFile: ts.SourceFile;   // 源文件AST

  /**
   * 构造函数
   * @param filePath - 要分析的TypeScript文件路径
   */
  constructor(filePath: string) {
    // 创建TypeScript程序，配置编译选项
    this.program = ts.createProgram([filePath], {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.CommonJS,
      strict: true,
    });

    // 获取源文件AST节点
    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) {
      throw new Error(`Unable to get source file: ${filePath}`);
    }

    this.sourceFile = sourceFile;
    this.typeChecker = this.program.getTypeChecker();
  }

  /**
   * 打印完整的AST结构
   * @param options - 分析选项配置
   */
  public printAst(options: AstAnalysisOptions = {}): void {
    // 合并默认选项和用户选项
    const opts = {
      showText: true,
      showTypes: true,
      showSymbols: true,
      maxTextLength: 100,
      ...options
    };

    console.log('TypeScript AST Analysis:');
    this.printNode(this.sourceFile, 0, opts);
  }

  /**
   * 获取文件中所有函数的信息
   * @returns 函数信息数组
   */
  public getFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    // 遍历AST，查找函数声明节点
    this.visitNode(this.sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        functions.push(this.analyzeFunctionDeclaration(node));
      }
    });
    return functions;
  }

  /**
   * 打印函数分析结果
   * 输出所有函数的详细信息
   */
  public printFunctionAnalysis(): void {
    console.log('\n=== Function Analysis ===');
    const functions = this.getFunctions();
    
    functions.forEach(func => {
      console.log(`Function: ${func.name}`);
      console.log(`  Signature: ${func.signature}`);
      console.log(`  Return Type: ${func.returnType}`);
      
      func.parameters.forEach((param, index) => {
        console.log(`  Parameter ${index}: ${param.name} : ${param.type}`);
      });
      console.log('');
    });
  }

  /**
   * 递归打印AST节点
   * @param node - 当前AST节点
   * @param depth - 缩进深度
   * @param options - 分析选项
   */
  private printNode(node: ts.Node, depth: number, options: Required<AstAnalysisOptions>): void {
    const indent = '  '.repeat(depth);
    const syntaxKind = ts.SyntaxKind[node.kind];
    
    console.log(`${indent}${syntaxKind} (${node.kind})`);
    
    // 根据选项显示不同的节点信息
    if (options.showText) {
      this.printNodeText(node, indent, options.maxTextLength);
    }
    
    if (options.showTypes) {
      this.printNodeType(node, indent);
    }
    
    if (options.showSymbols) {
      this.printNodeSymbol(node, indent);
    }
    
    // 递归处理子节点
    ts.forEachChild(node, (child) => {
      this.printNode(child, depth + 1, options);
    });
  }

  /**
   * 打印节点的文本内容
   * @param node - AST节点
   * @param indent - 缩进字符串
   * @param maxLength - 文本最大长度
   */
  private printNodeText(node: ts.Node, indent: string, maxLength: number): void {
    if (node.getFullText) {
      const text = node.getFullText().trim();
      if (text && text.length < maxLength) {
        console.log(`${indent}  Text: "${text}"`);
      }
    }
  }

  /**
   * 打印节点的类型信息
   * @param node - AST节点
   * @param indent - 缩进字符串
   */
  private printNodeType(node: ts.Node, indent: string): void {
    try {
      const type = this.typeChecker.getTypeAtLocation(node);
      if (type) {
        const typeString = this.typeChecker.typeToString(type);
        console.log(`${indent}  Type: ${typeString}`);
      }
    } catch (e) {
      // 某些节点可能没有类型信息，忽略错误
    }
  }

  /**
   * 打印节点的符号信息
   * @param node - AST节点
   * @param indent - 缩进字符串
   */
  private printNodeSymbol(node: ts.Node, indent: string): void {
    try {
      const symbol = this.typeChecker.getSymbolAtLocation(node);
      if (symbol) {
        console.log(`${indent}  Symbol: ${symbol.name} (${ts.SymbolFlags[symbol.flags]})`);
      }
    } catch (e) {
      // 某些节点可能没有符号信息，忽略错误
    }
  }

  /**
   * 访问AST中的每个节点
   * @param node - 起始节点
   * @param callback - 对每个节点执行的回调函数
   */
  private visitNode(node: ts.Node, callback: (node: ts.Node) => void): void {
    callback(node);
    ts.forEachChild(node, (child) => this.visitNode(child, callback));
  }

  /**
   * 分析函数声明节点
   * @param node - 函数声明节点
   * @returns 函数信息对象
   */
  private analyzeFunctionDeclaration(node: ts.FunctionDeclaration): FunctionInfo {
    // 获取函数名称，匿名函数显示为<anonymous>
    const name = node.name?.text || '<anonymous>';
    
    // 获取函数签名
    const signature = this.typeChecker.getSignatureFromDeclaration(node);
    const signatureString = signature 
      ? this.typeChecker.signatureToString(signature)
      : '<unknown>';

    // 分析函数参数
    const parameters = node.parameters.map((param) => ({
      name: param.name.getText(),
      type: this.typeChecker.typeToString(
        this.typeChecker.getTypeAtLocation(param)
      )
    }));

    // 获取返回值类型
    const returnType = node.type
      ? this.typeChecker.typeToString(
          this.typeChecker.getTypeFromTypeNode(node.type)
        )
      : 'void';

    return {
      name,
      signature: signatureString,
      parameters,
      returnType
    };
  }
}

/**
 * 分析指定文件的工具函数
 * @param filePath - 要分析的文件路径
 */
export function analyzeFile(filePath: string): void {
  const analyzer = new TypeScriptAstAnalyzer(filePath);
  
  // 打印AST结构
  analyzer.printAst({
    showText: true,
    showTypes: true,
    showSymbols: true,
    maxTextLength: 50
  });
  
  // 打印函数分析结果
  analyzer.printFunctionAnalysis();
}