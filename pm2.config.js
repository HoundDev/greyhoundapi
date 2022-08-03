module.exports = {
  apps: [{
    name: 'greyhoundapi',
    script: 'http.js',
    watch: false,
    instances: 1,
    exec_mode: 'cluster',
    ignore_watch: ["node_modules", "db", ".git"],
    args: ["--color"],
    env: {
      DEBUG: 'greyhoundapi*'
    },
    env_production: {
      DEBUG: 'greyhoundapi*'
    }
  }]
}