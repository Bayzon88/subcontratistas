server {
listen 80;
listen [::]:80;

        root /var/www/subcontratistas;
        index index.html;

        server_name subcontratistas;

    location /consorcio {
        proxy_pass http://localhost:3000; #whatever port your app runs on
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

}
