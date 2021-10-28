# HOWTO 

1. Mount `/var/log/pryv/audit/pryvio_core/` to `/app/audit` in pryvio_core docker container

```yaml
 core:
    image: "eu.gcr.io/pryvio/core:1.7.0-rc10"
    container_name: pryvio_core
    networks:
      - frontend
      - backend
    volumes:
      - ${PRYV_CONF_ROOT}/pryv/core/conf/:/app/conf/:ro
      - ${PRYV_CONF_ROOT}/pryv/core/data/:/app/data/
      - ${PRYV_CONF_ROOT}/pryv/core/log/:/app/log/
      - /dev/log:/dev/log # for audit log
      - /var/log/pryv/audit/pryvio_core/:/app/audit
```

2. Restart Pryvio core docker container: `docker restart pryvio_core`
3. Run the following commands: `docker exec -ti pryvio_core /app/bin/scripts/migrations/audit1.6-1.7/run_in_container.sh`



# License
Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 

This file is part of Open-Pryv.io and released under BSD-Clause-3 License

Redistribution and use in source and binary forms, with or without 
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, 
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, 
   this list of conditions and the following disclaimer in the documentation 
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors 
   may be used to endorse or promote products derived from this software 
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

SPDX-License-Identifier: BSD-3-Clause