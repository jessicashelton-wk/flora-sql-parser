'use strict';

const has = require('has');

const escapeMap = {
    '\0': '\\0',
    '\'': '\'\'',
    '"': '\\"',
    '\b': '\\b',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\x1a': '\\Z', // EOF
    '\\': '\\\\'
};

function escape(str) {
    const res = [];
    let char;

    for (let i = 0, l = str.length; i < l; ++i) {
        char = str[i];
        const escaped = escapeMap[char];
        if (escaped) char = escaped;
        res.push(char);
    }

    return res.join('');
}

function identifierToSql(ident) {
    return `"${ident}"`;
}

function literalToSQL(literal) {
    const { type } = literal;
    let { value } = literal;

    if (type === 'number') {
        /* nothing */
    } else if (type === 'string') value = '\'' + escape(value) + '\'';
    else if (type === 'bool') value = value ? 'TRUE' : 'FALSE';
    else if (type === 'null') value = 'NULL';
    else if (type === 'star') value = '*';
    else if (type === 'param') value = ':' + value;
    else if (type === 'time' || type === 'date' || type === 'timestamp') value = type.toUpperCase() + ' \'' + value + '\'';

    return !literal.parentheses ? value : '(' + value + ')';
}

let exprToSQLConvertFn = {};

function exprToSQL(expr) {
    return exprToSQLConvertFn[expr.type] ? exprToSQLConvertFn[expr.type](expr) : literalToSQL(expr);
}

function aggrToSQL(expr) {
    /** @type {Object} */
    const args = expr.args;
    let str = exprToSQL(args.expr);
    const fnName = expr.name;

    if (has(args, 'distinct') && args.distinct !== null) str = 'DISTINCT ' + str;

    return fnName + '(' + str + ')';
}

function binaryToSQL(expr) {
    let operator = expr.operator;
    if (operator === 'AND' || operator === 'OR') {
        operator += '\n';
    }

    let rstr = exprToSQL(expr.right);

    if (Array.isArray(rstr)) {
        if (operator === '=') operator = 'IN';
        if (operator === '!=') operator = 'NOT IN';
        if (operator === 'BETWEEN' || operator === 'NOT BETWEEN') rstr = rstr[0] + ' AND ' + rstr[1];
        else rstr = '(' + rstr.join(', ') + ')';
    }

    const str = exprToSQL(expr.left) + ' ' + operator + ' ' + rstr;

    return !expr.parentheses ? str : '(' + str + ')';
}

function caseToSQL(expr) {
    const res = ['CASE'];
    const conditions = expr.args;

    if (expr.expr) res.push(exprToSQL(expr.expr));

    for (let i = 0, l = conditions.length; i < l; ++i) {
        res.push(conditions[i].type.toUpperCase()); // when/else
        if (conditions[i].cond) {
            res.push(exprToSQL(conditions[i].cond));
            res.push('THEN');
        }
        res.push(exprToSQL(conditions[i].result));
    }

    res.push('END');

    return res.join(' ');
}

function castToSQL(expr) {
    let str = 'CAST(';
    str += exprToSQL(expr.expr) + ' AS ';
    str += expr.target.dataType + (expr.target.length ? '(' + expr.target.length + ')' : '');
    str += ')';

    return str;
}

function tryCastToSQL(expr) {
    let str = 'TRY_CAST(';
    str += exprToSQL(expr.expr) + ' AS ';
    str += expr.target.dataType + (expr.target.length ? '(' + expr.target.length + ')' : '');
    str += ')';

    return str;
}

function columnRefToSQL(expr) {
    let str = expr.column !== '*' ? identifierToSql(expr.column) : '*';
    if (has(expr, 'table') && expr.table !== null) str = identifierToSql(expr.table) + '.' + str;
    return !expr.parentheses ? str : '(' + str + ')';
}

function mapRefToSQL(expr) {
    let str = expr.column + '[\'' + expr.key + '\']';
    if (has(expr, 'table') && expr.table !== null) str = identifierToSql(expr.table) + '.' + str;
    return !expr.parentheses ? str : '(' + str + ')';
}

function getExprListSQL(exprList) {
    return exprList.map(exprToSQL);
}

function funcToSQL(expr) {
    if (expr.name === 'CURRENT_DATE' ||
        expr.name === 'CURRENT_TIME' ||
        expr.name === 'CURRENT_TIMESTAMP' ||
        expr.name === 'LOCALTIME' ||
        expr.name === 'LOCALTIMESTAMP') {
        return expr.name;
    }
    const str = expr.name + '(' + exprToSQL(expr.args).join(', ') + ')';
    return !expr.parentheses ? str : '(' + str + ')';
}

/**
 * Stringify column expressions
 *
 * @param {Array} columns
 * @return {string}
 */
function columnsToSQL(columns) {
    return columns
        .map((column) => {
            let str = exprToSQL(column.expr);

            if (column.as !== null) {
                str += ' AS ';
                if (column.as.match(/^[a-z_][0-9a-z_]*$/i)) str += identifierToSql(column.as);
                else str += '"' + column.as + '"';
            }
            return str;
        })
        .join(',\n ');
}

/**
 * @param {Array} tables
 * @return {string}
 */
function tablesToSQL(tables) {
    const baseTable = tables[0];
    const clauses = [];
    if (baseTable.type === 'dual') return 'DUAL';
    let str = baseTable.table ? identifierToSql(baseTable.table) : exprToSQL(baseTable.expr);

    if (baseTable.db && baseTable.db !== null) str = identifierToSql(baseTable.db) + '.' + str;
    if (baseTable.system && baseTable.system !== null) str = baseTable.system + '.' + str;
    if (baseTable.as !== null) str += ' AS ' + identifierToSql(baseTable.as);
    clauses.push(str);

    for (let i = 1; i < tables.length; i++) {
        const joinExpr = tables[i];

        str = (joinExpr.join && joinExpr.join !== null) ? '\n ' + joinExpr.join + '\n ' : str = ',\n ';

        if (joinExpr.table) {
            if (joinExpr.system && joinExpr.system !== null) str += joinExpr.system + '.';
            if (joinExpr.db !== null) str += (identifierToSql(joinExpr.db) + '.');
            
            str += identifierToSql(joinExpr.table);
        } else {
            str += exprToSQL(joinExpr.expr);
        }

        if (joinExpr.as !== null) str += ' AS ' + identifierToSql(joinExpr.as);
        if (has(joinExpr, 'on') && joinExpr.on !== null) str += ' \nON ' + exprToSQL(joinExpr.on);
        if (has(joinExpr, 'using')) str += ' USING (' + joinExpr.using.map(identifierToSql).join(', ') + ')';
        clauses.push(str);
    }

    return clauses.join('');
}

/**
 * @param {Object}          stmt
 * @param {?Array}          stmt.options
 * @param {?string}         stmt.distinct
 * @param {?Array|string}   stmt.columns
 * @param {?Array}          stmt.from
 * @param {?Object}         stmt.where
 * @param {?Array}          stmt.groupby
 * @param {?Object}         stmt.having
 * @param {?Array}          stmt.orderby
 * @param {?Array}          stmt.limit
 * @return {string}
 */
function selectToSQL(stmt) {
    const clauses = ['SELECT\n'];

    if (has(stmt, 'options') && Array.isArray(stmt.options)) clauses.push(stmt.options.join(' '));
    if (has(stmt, 'distinct') && stmt.distinct !== null) clauses.push(stmt.distinct);

    if (stmt.columns !== '*') clauses.push(columnsToSQL(stmt.columns));
    else clauses.push('*');

    // FROM + joins
    if (Array.isArray(stmt.from)) clauses.push('\n\nFROM\n', tablesToSQL(stmt.from));

    if (has(stmt, 'where') && stmt.where !== null) clauses.push('\n\nWHERE\n ' + exprToSQL(stmt.where));
    if (Array.isArray(stmt.groupby)) clauses.push('\n\nGROUP BY', getExprListSQL(stmt.groupby).join(', '));
    if (has(stmt, 'having') && stmt.having !== null) clauses.push('\n\nHAVING ' + exprToSQL(stmt.having));

    if (Array.isArray(stmt.orderby)) {
        const orderExpressions = stmt.orderby.map(expr => exprToSQL(expr.expr) + ' ' + expr.type);
        clauses.push('\n\nORDER BY', orderExpressions.join(', '));
    }

    if (Array.isArray(stmt.limit)) clauses.push('\n\nLIMIT', stmt.limit.map(exprToSQL));

    return clauses.join(' ');
}

function unaryToSQL(expr) {
    const str = expr.operator + ' ' + exprToSQL(expr.expr);
    return !expr.parentheses ? str : '(' + str + ')';
}

function unionToSQL(stmt) {
    const res = [selectToSQL(stmt)];

    while (stmt._next) {
        res.push('UNION', selectToSQL(stmt._next));
        stmt = stmt._next;
    }

    return res.join(' ');
}

exprToSQLConvertFn = {
    aggr_func: aggrToSQL,
    binary_expr: binaryToSQL,
    case: caseToSQL,
    cast: castToSQL,
    try_cast: tryCastToSQL,
    column_ref: columnRefToSQL,
    map_ref: mapRefToSQL,
    expr_list: (expr) => {
        const str = getExprListSQL(expr.value);
        return !expr.parentheses ? str : `(${str})`;
    },
    function: funcToSQL,
    select: (expr) => {
        const str = typeof expr._next !== 'object'
            ? selectToSQL(expr)
            : unionToSQL(expr);
        return !expr.parentheses ? str : `(${str})`;
    },
    unary_expr: unaryToSQL
};

module.exports = function toSQL(ast) {
    if (ast.type !== 'select') throw new Error('Only SELECT statements supported at the moment');
    return unionToSQL(ast);
};
