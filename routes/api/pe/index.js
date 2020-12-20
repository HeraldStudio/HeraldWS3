// const cheerio = require('cheerio')
const sdk = require('../../../sdk/sdk.json')
const axios = require('axios')
const sha = require('sha1')
const moment = require('moment')

const hintTable = [
  '小猴提醒：起床不抓紧，跑操两行泪',      // 学期初提醒
  '小猴提醒：不错哦～要继续保持～',
  '小猴提醒：要抓紧跑操哦～',
  '小猴叹息：小猴为你的跑操感到悲哀',      // 彻底跑不完了
  '小猴祝贺：恭喜你已经完成了跑操任务🎉'   // 完成跑操任务
]

const en2ch = {//好像数据没性别
    score: '总分',
    sex: '性别',
    stature: '身高',
    avoirdupois: '体重',
    vitalCapacity: '肺活量',
    fiftyMeter: '50米',
    standingLongJump: '立定跳远',
    BMI: 'BMI',
    bend: '坐体前屈',
    kiloMeter: '1000米',
    lie: '引体向上'
  }

exports.route = {

  /**
  * GET /api/pe
  * 跑操查询
  * 暂时先不使用缓存
  * @Return { count, detail, health, remainDays, hint }
  **/

  /**
  * @api {GET} /api/pe 跑操查询
  * @apiGroup pe
  */
  async get() {

    if (!this.user.isLogin) {
      throw 401
    }

    const cardnum = this.user.cardnum
    const now = +moment()

    let Year=moment().format("YYYY")
    if(moment().format("MM")<2){
        Year=Year-1;//它这个好像只有年份没有学期，那一月份应该还算上一年吧...
    }
    let res = await axios.post(sdk.fitness.url,{
        "schoolYear": `${Year}`,
        "studentNo": `${cardnum}`
    })

    let healthList = Object.keys(res.data.data)
    let health = []
    healthList.forEach(healthItem => {
        let tempData = {}
        if(healthItem=='0'){
          tempData['name'] = '总分'
        }
        else{
          tempData['name'] = res.data.data[healthItem].itemName
        }
        if(healthItem!='0'&&healthItem!='1'&&healthItem!='2')
        tempData['value'] = res.data.data[healthItem].testValue+res.data.data[healthItem].itemUnit
        if(res.data.data[healthItem].testScore!=undefined)
        tempData['score'] = res.data.data[healthItem].testScore;
        if(res.data.data[healthItem].testLevelDesc!=undefined)
        tempData['level'] = res.data.data[healthItem].testLevelDesc;
        if(res.data.data[healthItem].testTime!=undefined)
        tempData['time'] = res.data.data[healthItem].testTime;
        health.push(tempData)
    })

/*health
[
  { name: '总分', score: 74.6, level: '及格' },
  { name: '左眼裸眼视力', time: '2020-12-15T11:20:12.000' },
  { name: '右眼裸眼视力', time: '2020-12-15T11:20:12.000' },
  {
    name: '1000米跑',
    value: '230分·秒',
    score: 76,
    level: '及格',
    time: '2020-12-15T11:13:48.000'
  },
  {
    name: '50米跑',
    value: '7秒',
    score: 85,
    level: '良好',
    time: '2020-12-15T11:13:45.000'
  },
  {
    name: '坐位体前屈',
    value: '13.6厘米',
    score: 74,
    level: '及格',
    time: '2020-12-15T10:59:27.000'
  },
  {
    name: '立定跳远',
    value: '255厘米',
    score: 80,
    level: '良好',
    time: '2020-12-15T10:59:24.000'
  },
  {
    name: '体重指数（BMI）',
    value: '23.1千克/米²',
    score: 100,
    level: '正常',
    time: '2020-12-15T10:48:57.000'
  },
  { name: '身高', value: '179.6厘米', time: '2020-12-15T10:48:57.000' },
  { name: '体重', value: '74.6公斤', time: '2020-12-15T10:48:57.000' },
  {
    name: '肺活量',
    value: '4362毫升',
    score: 80,
    level: '良好',
    time: '2020-12-15T10:46:25.000'
  }
]
*/

    let res = await axios.post(sdk.exercise.url,{
        "schoolYear": `${Year}`,
        "studentNo": `${cardnum}`
    })
    let runList=Object.keys(res.data.data)
    let runCount=Object.keys(res.data.data).length//跑操次数
    let runTime=[]//跑操时间列表
    runList.forEach(item=>{
        let runD={}
        runD['Time']=res.data.data[item].recordTime
        runTime.push(runD)
    })
    //console.log(runTime)
    //console.log(runCount)

 
    const count = runCount

    // 计算跑操剩余天数
    // 默认跑操时间前16周 
    const beginOfTerm = this.term.currentTerm.startDate
    const remainDays = Array(16 * 7).fill()
      // 当前学期每一天的跑操结束时间戳
      // 注意这里要克隆一次，不能在原对象上直接操作
      .map((_, i) => +(moment(beginOfTerm).clone().add(i, 'days').hour(7).minute(20)))
      // 过滤掉时间比现在晚的
      .filter(k => now < k)
      // 时间戳变为星期
      .map(k => moment(k).day())
      // 过滤掉周末
      .filter(k => k >= 1 && k <= 5)
      .length
    // console.log(remainDays)

    let hint
    if (now < +(moment(this.term.currentTerm.startDate).add(45, 'day'))) {
      // 开学一个月之前，显示提醒用语
      hint = hintTable[0]
    } else if ((45 - count) > remainDays) {
      // 剩余天数不够了，显示悲哀用语
      hint = hintTable[3]
    } else if (count >= 45) {
      // 完成跑操任务
      hint = hintTable[4]
    } else {
      // 随机一个
      hint = hintTable[now % 2 + 1]
    }

    return { count, detail: runTime, health, remainDays, hint }

  }
}
