const cheerio = require('cheerio')

exports.route = {

  /**
  * GET /api/exam
  * 个人考试信息查询
  **/

  async get() {
    return await this.userCache('10m', async () => {

      let { name, cardnum } = this.user

      // 新考试安排系统-目前使用18级本科生数据进行测试
      if (/^21318/.test(cardnum)) { 
        // 1. 需要使用 ids6 认证
        await this.useAuthCookie({ ids6: true })

        // 2. 获取下一步操作所需的 URL
        const urlRes = await this.get('http://ehall.seu.edu.cn/appMultiGroupEntranceList?appId=4768687067472349&r_t=' + Date.now())

        let url = '';
        urlRes.data && urlRes.data.data && urlRes.data.data.groupList && urlRes.data.data.groupList[0] &&
        (url = urlRes.data.data.groupList[0].targetUrl);
        if (!url)
          throw 400;

        // 3. 访问一下上述 URL ，获取名为 _WEU 的 cookie
        await this.get(url)

        // 4. 获取学期代号
        let termRes = await this.post('http://ehall.seu.edu.cn/jwapp/sys/studentWdksapApp/modules/wdksap/dqxnxq.do')
        let termCode = termRes.data.datas.dqxnxq.rows[0].DM

        // 5. 获取原始的考试安排数据
        let examData = await this.post('http://ehall.seu.edu.cn/jwapp/sys/studentWdksapApp/modules/wdksap/wdksap.do', 
                                      {XNXQDM: termCode,
                                      '*order':' -KSRQ,-KSSJMS'})
        examData = examData.data.datas.wdksap.rows
        let examList = examData.map( k => {
          // 分析时间
          let rawTime = k.KSSJMS
          rawTime = rawTime.split('(')[0]
          let date = rawTime.split(' ')[0]
          let [startTime, endTime] = rawTime.split(' ')[1].split('-')
          startTime = +moment(date+'-'+startTime, 'YYYY-MM-DD-HH:mm')
          endTime = +moment(date+'-'+endTime, 'YYYY-MM-DD-HH:mm')
          duration = (endTime - startTime) / 1000 / 60
          return {
            startTime,endTime,duration,
            semester:k.XNXQDM,
            campus:'-',
            courseName:k.KCM,
            courseType:k.KSMC,
            teacherName:k.ZJJSXM,
            location:k.JASMC
          }
        })
        this.logMsg = `${name} (${cardnum}) - 查询 2018 级考试安排`
        return examList
      }

      // 先检查可用性，不可用直接抛异常或取缓存
      this.guard('http://xk.urp.seu.edu.cn/studentService/system/showLogin.action')

      await this.useAuthCookie()
      // 经测试，使用老门户的 cookie，并不需要再登录教务处。
      res = await this.get(
        'http://xk.urp.seu.edu.cn/studentService/cs/stuServe/runQueryExamPlanAction.action'
      )

      let $ = cheerio.load(res.data)
      let now = +moment()

      this.logMsg = `${name} (${cardnum}) - 查询考试安排`
      return $('#table2 tr').toArray().slice(1).map(tr => {
        let [semester, campus, courseName, courseType, teacherName, time, location, duration]
          = $(tr).find('td').toArray().slice(1).map(td => $(td).text().trim())

        let startMoment = moment(time, 'YYYY-MM-DD HH:mm(dddd)')
        let startTime = +startMoment
        let endTime = +startMoment.add(duration, 'minutes')

        return {semester, campus, courseName, courseType, teacherName, startTime, endTime, location, duration}
      }).filter(k => k.endTime > now) // 防止个别考生考试开始了还没找到考场🤔
    })
  }
}
