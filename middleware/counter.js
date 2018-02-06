/**
  # 计数器中间件

  在命令行最后一行显示当前请求计数器
 */
const ora = require('ora')

const spinner = ora({
  spinner: {
    interval: 100,
    frames: ['→']
  }
}).start()

const updateConnections = (count) => {
  if (count <= 1) {
    spinner.text = count + ' request running'
  } else {
    spinner.text = count + ' requests running'
  }
}

let connections = 0
updateConnections(0)
for (let key in console) {
  [console['_' + key], console[key]] = [console[key], function() {
    spinner.stop()
    console['_' + key].apply(undefined, arguments)
    spinner.start()
  }]
}

console.log('')

module.exports = async (ctx, next) => {
  updateConnections(++connections)
  await next()
  updateConnections(--connections)
}
