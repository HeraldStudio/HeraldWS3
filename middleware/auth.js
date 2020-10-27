/**
  # 用户身份认证中间件

  ## 对接统一身份认证啦！
  我们终于不需要冒着巨大的（被查水表的）风险获取用户的一卡通和密码啦～
  
  ## 身份认证流程
  保持完整的前后端分离特性，同时提供灵活性。
  1. webservice 接受来自前端的 ticket 和 service，和 ids 服务器换取用户的「一卡通号」
  2. 依次从 T_BZKS 、T_YJS 、T_JZG_JBXX 表中根据一卡通号查询记录，进行完整性校验
  3. 生成 token 下发给用户，将 tokenHash = SHA256(token) 插入 H_AUTH

  ## 鉴权流程
  1. 从请求头中获取 x-api-token 字段
  2. 计算 tokenHash 并从数据库中查找记录
  3. 向下层提供信息
  
  ## 依赖接口

  ctx.params          from params.js
  ctx.get             from axios.js

  ## 暴露接口

  ctx.user.isLogin    boolean             仅已登录用户带 token 请求时有效，否则为 false
  ctx.user.tokenHash  string?             登录设备唯一识别码。若同一个用户多处登录，该识别码不相同
  ctx.user.cardnum    string?             用户一卡通号码
  ctx.user.name       string?             用户姓名
  ctx.user.schoolnum  string?             用户学号（教师为空）
  ctx.user.platform   string?             用户登录时使用的平台识别符
  
  注：

  以上接口除 isLogin 外，其他属性一旦被获取，将对用户进行鉴权，不允许游客使用；因此，若要定义用户和游客
  均可使用的功能，需要先通过 isLogin 区分用户和游客，然后对用户按需获取其他属性，不能对游客获取用户属性，
  否则将抛出 401。
 */

const crypto = require('crypto')
const xmlparser = require('fast-xml-parser')
//const axios =  require('axios')
const { config } = require('../app')
const { authenticate } = require('ldap-authentication')
const ldapConfig = require('../sdk/sdk.json').ldap
const authConfig = require('../sdk/sdk.json').auth


const tokenHashPool = {} // 用于缓存tokenHash，防止高峰期数据库爆炸💥

// 对称加密算法，要求 value 是 String 或 Buffer，否则会报错
const encrypt = (value) => {
  try {
    let cipheriv = crypto.createCipheriv(config.auth.cipher, authConfig.key, authConfig.iv)
    let result = cipheriv.update(value, 'utf8', 'hex')
    result += cipheriv.final('hex')
    return result
  } catch (e) {
    console.log(e)
    return ''
  }
}

// 对称解密算法，要求 value 是 String 或 Buffer，否则会报错
const decrypt = (value) => {
  try {
    let decipheriv = crypto.createDecipheriv(config.auth.cipher, authConfig.key, authConfig.iv)
    let result = decipheriv.update(value, 'hex', 'utf8')
    result += decipheriv.final('utf8')
    return result
  } catch (e) {
    console.log(e)
    return ''
  }
}

// 哈希算法，用于对 token 进行摘要
const hash = value => {
  return Buffer.from(crypto.createHash('sha256').update(value).digest()).toString('hex')
}


module.exports = async (ctx, next) => {

  // 对于 auth 路由的请求，直接截获，不交给 kf-router
  if (ctx.path === '/auth') {
    // POST /auth 登录认证
    if (ctx.method.toUpperCase() !== 'POST') {
      throw 405
    }

    let { ticket, service, platform, cardnum, password, captcha, captchaAnswer } = ctx.params

    let now = moment()

    // 登录是高权限操作，需要对参数类型进行检查，防止通过 Object 注入数据库
    // 例如 platform 若允许传入对象 { $neq: '' }，将会触发 Sqlongo 语法，导致在下面删除时把该用户在所有平台的记录都删掉
    // if (typeof ticket !== 'string'
    //   || typeof service !== 'string') {
    //   throw '缺少统一身份认证参数'
    // }

    if (!platform) {
      throw '缺少参数 platform: 必须指定平台名'
    } else if (!/^[0-9a-z-]+$/.test(platform)) {
      throw 'platform 只能由小写字母、数字和中划线组成' // 为了美观（通神nb
    }

    if (typeof captcha === 'string'
      && typeof captchaAnswer === 'string'
      && typeof cardnum === 'string'
      && typeof password === 'string') {
      let record = await ctx.db.execute(`
      SELECT CAPTCHA_TEXT, EXPIRE_TIME
      FROM H_CAPTCHA
      WHERE CAPTCHA_HASH = :captcha
      `, { captcha: hash(captcha) })

      // 验证码的检验
      if (record.rows.length !== 1) {
        throw '验证码失效'
      }
      let [captchaText, expireTime] = record.rows[0]
      if (expireTime < now) {
        throw '验证码失效'
      }
      if (captchaText !== captchaAnswer.toUpperCase()) {
        throw '验证码错误'
      }
      await ctx.db.execute(`
      DELETE FROM H_CAPTCHA
      WHERE CAPTCHA_HASH = :captcha
      `, { captcha: hash(captcha) })
      //LDAP 验证
      try {
        await authenticate({
          ldapOpts: { url: ldapConfig.ldapUrl },
          adminDn: ldapConfig.adminDn,
          adminPassword: ldapConfig.adminPassword,
          userSearchBase: ldapConfig.userSearchBase,
          username: cardnum,
          userPassword: password,
          usernameAttribute: 'uid',
        })
      } catch (err) {
        if (err.lde_message === 'Invalid Credentials') {
          throw '密码错误'
        } else if (err.name === 'LdapAuthenticationError') {
          throw '一卡通不存在'
        } else {
          throw err
        }
      }

    } else if (typeof ticket === 'string'
      && typeof service === 'string') {
      // 登录是高权限操作，需要对参数类型进行检查，防止通过 Object 注入数据库
      // 例如 platform 若允许传入对象 { $neq: '' }，将会触发 Sqlongo 语法，导致在下面删除时把该用户在所有平台的记录都删掉
      try {
        // 从IDS获取一卡通号
        const serviceValidateURL = `https://newids.seu.edu.cn/authserver/serviceValidate?service=${service}&ticket=${ticket}`
        const res = await ctx.get(serviceValidateURL)
        const data = xmlparser.parse(res.data.toString())['cas:serviceResponse']['cas:authenticationSuccess']['cas:attributes']
        cardnum = '' + data['cas:uid']
      } catch (e) {
        console.log(e)
        throw '统一身份认证过程出错'
      }
    } else {
      throw '缺少统一身份认证参数'
    }

    // 从数据库查找学号、姓名
    let name, schoolnum
    if (cardnum.startsWith('21')) {
      // 本科生库
      const record = await ctx.db.execute(
        `SELECT XM, XJH 
        FROM TOMMY.T_BZKS
        WHERE XH=:cardnum`, [cardnum]
      )
      if (record.rows.length > 0) {
        name = record.rows[0][0]
        schoolnum = record.rows[0][1]
      }
    } else if (cardnum.startsWith('22') || cardnum.startsWith('23')) {
      // 研究生库
      // TODO 暂时不支持
      const record = await ctx.db.execute(
        `SELECT XM, YJSXH FROM TOMMY.T_YJSJBXX
        WHERE XH=:cardnum`, [cardnum]
      )
      if (record.rows.length > 0) {
        name = record.rows[0][0]
        schoolnum = record.rows[0][1]
      }
      // throw '小猴偷米目前只支持本科生使用哦～'
    } else if (cardnum.startsWith('10')) {
      // 教职工库
      // TODO 暂时不支持
      const record = await ctx.db.execute(
        `SELECT XM FROM TOMMY.T_JZG_JBXX
        WHERE ZGH=:cardnum`, [cardnum]
      )
      if (record.rows.length > 0) {
        name = record.rows[0][0]
        schoolnum = cardnum // 临时加一下
      }
    } else {
      throw '小猴偷米目前只支持本科生使用哦～'
    }

    if (!name) {
      if (cardnum.startsWith(('213' + new Date().getFullYear().toString().substr(2, 4)))) {
        throw '新生信息还没有录入，' + new Date().getFullYear() + '级的小可爱不要着急喔～'
      }
      throw '身份完整性校验失败'
    }

    // 生成 32 字节 token 转为十六进制，及其哈希值
    let token = Buffer.from(crypto.randomBytes(20)).toString('hex')
    let tokenHash = hash(token)

    if (platform === 'wechat') {
      const { sessionid } = ctx.params
      try {
        await ctx.db.execute(`
        UPDATE TOMMY.H_OPENID_AND_TOKEN SET TOKEN = :token, CARDNUM = :cardnum
        WHERE SESSIONID = :sessionid`, {
          token,
          cardnum,
          sessionid
        })
      } catch (e) {
        console.log(e)
        throw '微信绑定过程出错'
      }
    }

    // 将新用户信息插入数据库

    // 向数据库插入记录
    await ctx.db.execute(
      `INSERT INTO TOMMY.H_AUTH 
      (TOKEN_HASH, CARDNUM, REAL_NAME, CREATED_TIME, PLATFORM, LAST_INVOKED_TIME, SCHOOLNUM)
      VALUES (:tokenHash, :cardnum, :name, :createdTime, :platform, :lastInvokedTime, :schoolnum )
      `,
      {
        tokenHash,
        cardnum,
        name,
        createdTime: now.toDate(),
        lastInvokedTime: now.toDate(),
        schoolnum,
        platform
      }
    )

    ctx.body = token
    ctx.logMsg = `${name} [${cardnum}] - 身份认证成功 - 登录平台 ${platform}`
    return

  } else if (ctx.request.headers['x-api-token']) {
    let token
    // 首先判断是不是来自微信的请求
    if (ctx.fromWechat) {
      // 微信来的请求不可能带着我们的token，只有微信的openid
      // 先把这个openid换成token
      token = await ctx.db.execute(`
      SELECT TOKEN FROM TOMMY.H_OPENID_AND_TOKEN WHERE OPENID = :openid
      `, {
        openid: ctx.request.headers['x-api-token']
      })

      if (token.rows.length > 0) {
        token = token.rows[0][0]
      } else {
        token = ''
      }
    } else {
      // 对于来自其他平台的其他请求，根据 token 的哈希值取出表项
      token = ctx.request.headers['x-api-token']
    }
    let tokenHash = hash(token)
    // 第一步查内存缓存
    let record = tokenHashPool[tokenHash]

    if (!record) {
      // 缓存没有命中
      record = await ctx.db.execute(`
      SELECT CARDNUM, REAL_NAME, CREATED_TIME, LAST_INVOKED_TIME, SCHOOLNUM, PLATFORM
      FROM TOMMY.H_AUTH
      WHERE TOKEN_HASH=:tokenHash`, { tokenHash }
      )
      if (record.rows.length > 0) {
        // 数据库找到啦
        record = {
          cardnum: record.rows[0][0],
          name: record.rows[0][1],
          createdTime: moment(record.rows[0][2]).unix(),
          lastInvokedTime: moment(record.rows[0][3]).unix(),
          schoolnum: record.rows[0][4],
          platform: record.rows[0][5],
        }
        tokenHashPool[tokenHash] = record
      } else {
        record = null
      }
    }

    if (record) {
      let now = moment()
      let lastInvokedTime = record.lastInvokedTime
      // 每 4 小时更新一次用户上次调用时间
      if (now - lastInvokedTime >= 4 * 60 * 60 * 1000) {
        await ctx.db.execute(`
          UPDATE TOMMY.H_AUTH
          SET LAST_INVOKED_TIME = :now
          WHERE TOKEN_HASH = :tokenHash`, { now: now.toDate(), tokenHash }
        )
        record.lastInvokedTime = now.unix()
      }

      let {
        cardnum, name, schoolnum, platform,
      } = record

      // 将用户信息暴露给下层中间件
      ctx.user = {
        isLogin: true,
        token: tokenHash,
        cardnum, name, schoolnum, platform, encrypt, decrypt
      }

      // 调用下游中间件
      await next()
      return
    }

  }


  /* eslint getter-return:off */
  // 对于没有 token 或 token 失效的请求，若下游中间件要求取 user，说明功能需要登录，抛出 401
  let reject = () => { throw 401 }
  ctx.user = {
    isLogin: false,
    get cardnum() { reject() },
    get name() { reject() },
    get schoolnum() { reject() },
    get platform() { reject() },
    // get encrypt() { reject() },
    // get decrypt() { reject() },
    encrypt, decrypt
  }

  // 调用下游中间件
  await next()
}
