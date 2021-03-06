module.exports = function(grunt) {

    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),
        copy: {
            app: {
                files: [{
                    expand: true,
                    cwd: 'src/',
                    src: ['data/blank.png', 'data/configs.json' ,'resources/font-awesome/**', 'resources/images/**', 'resources/css/images/**', 'index.html'],
                    dest: 'dist/'
                }]
            },
            ol: {
                files: [{
                    expand: true,
                    flatten: true,
                    src: '../ol3/build/ol.js',
                    dest: 'dist/'
                }]
            }
        },
        concat: {
            dist: {
                src: ['src/js/*.js', '!src/js/analytics.js'],
                dest: 'dist/temp.js'
            },
            lib: {
                src: ['src/resources/js/*.js', 'dist/ol.js', 'dist/temp_min.js', 'src/js/analytics.js'],
                dest: 'dist/app.min.js'
            },
            css: {
                src: ['src/resources/css/ol.css','src/resources/css/jquery-ui.min.css','src/resources/css/base.css','src/resources/css/controlbar.css','src/resources/css/showcase.css'],
                dest: 'dist/resources/css/app.css'
            }
        },
        removeLoggingCalls: {
            files: ['dist/temp.js'],
            options: {
                methods: ['log', 'info', 'assert'],
                strategy: function(consoleStatement) {
                    // comments console calls statements 
                    // return '/* ' + consoleStatement + '*/';
                    return ''; // to remove  
                }
            }
        },
        replace: {
            dist: {
                src: ['dist/temp.js'],
                overwrite: true,
                replacements: [{
                    from: "url: 'http://eu.elasticterrain.xyz/",
                    to: "url: '../"
                }]
            }
        },
        uglify: {
            options: {
                banner: '/*! <%= pkg.name %> <%= grunt.template.today("yyyy-mm-dd") %> */\n'
            },
            build: {
                src: 'dist/temp.js',
                dest: 'dist/temp_min.js'
            }
        },
        clean: {
            all: ['dist/*'],
            js: ["dist/*.js", "!dist/*.min.js"]
        },
        processhtml: {
            js: {
                files: {
                    'dist/index.html': ['dist/index.html']
                }
            },
        },
    });

    grunt.loadNpmTasks('grunt-contrib-concat');
    grunt.loadNpmTasks('grunt-contrib-uglify');
    grunt.loadNpmTasks('grunt-contrib-copy');
    grunt.loadNpmTasks('grunt-contrib-clean');
    grunt.loadNpmTasks('grunt-processhtml');
    grunt.loadNpmTasks('grunt-remove-logging-calls');
    grunt.loadNpmTasks('grunt-text-replace');


    grunt.log.write('Building...').ok();

    grunt.registerTask('default', ['clean:all', 'copy:app', 'copy:ol', 'concat', 'replace', 'removeLoggingCalls', 'uglify', 'concat:lib', 'copy', 'processhtml', 'clean:js']);

};
